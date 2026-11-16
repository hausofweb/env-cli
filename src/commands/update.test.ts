import { describe, expect, it, vi } from "vitest";

import { EnvFilterService } from "../services/env-filter.service";
import type { AppConfig } from "../types/app-config.types";
import {
  findVariableScope,
  parseEnvContent,
  parseSSMTypeAnnotations,
} from "../utils/env-parser";
import { chooseHome } from "./add";
import {
  planRescope,
  replaceVariableLine,
  rescopeVariableLine,
  variableAudience,
  writeChanges,
} from "./update";
import type { WriteChangesDependencies } from "./update";

describe(replaceVariableLine, () => {
  const directivesContent = [
    "# @apps: api, app",
    "# SecureString",
    'STRIPE_SECRET_KEY="sk_test_old"',
    "",
    "# @global",
    "# String",
    'NEXT_PUBLIC_APP_URL="https://example.test"',
    "",
  ].join("\n");

  // The directives say who sees the variable and how it syncs. Rotating a
  // value must not disturb them, or the variable silently changes scope.
  it("keeps the surrounding directives and other variables intact", () => {
    const { content: updated } = replaceVariableLine({
      content: directivesContent,
      key: "STRIPE_SECRET_KEY",
      value: "sk_test_new",
    });

    expect(updated).toContain("# @apps: api, app");
    expect(updated).toContain("# SecureString");
    expect(updated).toContain('NEXT_PUBLIC_APP_URL="https://example.test"');
  });

  it("swaps the old value for the new one", () => {
    const { content: updated, replaced } = replaceVariableLine({
      content: directivesContent,
      key: "STRIPE_SECRET_KEY",
      value: "sk_test_new",
    });

    expect(replaced).toBe(1);
    expect(updated).toContain('STRIPE_SECRET_KEY="sk_test_new"');
    expect(updated).not.toContain("sk_test_old");
  });

  // `env add` on an existing key appends a second definition and leaves the
  // first in place, so a real file can hold both. Replacing only the first
  // would leave the dead secret behind — the whole reason this command exists.
  it("replaces every definition, not just the first", () => {
    const content = [
      'STRIPE_SECRET_KEY="sk_test_first"',
      "# @apps: api",
      "# SecureString",
      'STRIPE_SECRET_KEY="sk_test_second"',
    ].join("\n");

    const { content: updated, replaced } = replaceVariableLine({
      content,
      key: "STRIPE_SECRET_KEY",
      value: "sk_test_new",
    });

    expect(replaced).toBe(2);
    expect(updated).not.toContain("sk_test_first");
    expect(updated).not.toContain("sk_test_second");
  });

  it("does not touch a variable that merely shares a prefix", () => {
    const content = [
      'STRIPE_SECRET_KEY_OLD="keep_me"',
      'STRIPE_SECRET_KEY="replace_me"',
    ].join("\n");

    const { content: updated, replaced } = replaceVariableLine({
      content,
      key: "STRIPE_SECRET_KEY",
      value: "sk_test_new",
    });

    expect(replaced).toBe(1);
    expect(updated).toContain('STRIPE_SECRET_KEY_OLD="keep_me"');
    expect(updated).toContain('STRIPE_SECRET_KEY="sk_test_new"');
  });

  // The command refuses rather than inventing a definition: adding a variable
  // needs the app and type directives that only `env add` collects.
  it("reports nothing replaced when the variable is absent", () => {
    const { replaced } = replaceVariableLine({
      content: 'OTHER="value"\n',
      key: "STRIPE_SECRET_KEY",
      value: "sk_test_new",
    });

    expect(replaced).toBe(0);
  });

  it("escapes quotes and backslashes so the value survives a round trip", () => {
    const { content } = replaceVariableLine({
      content: 'PASSWORD="old"\n',
      key: "PASSWORD",
      value: 'a"b\\c',
    });

    expect(content).toContain('PASSWORD="a\\"b\\\\c"');
  });
});

const visibleKeys = (content: string, appName: string) =>
  EnvFilterService.filterForApp(content, appName).map(({ key }) => key);

describe(rescopeVariableLine, () => {
  const sharedContent = [
    "# @apps: api, app, scripts",
    "# SecureString",
    'STRIPE_SECRET_KEY="sk_test_secret"',
    "# String",
    'ADMIN_EMAILS="a@example.test"',
    "",
    "# @global",
    "# String",
    'NEXT_PUBLIC_APP_URL="https://example.test"',
    "",
  ].join("\n");

  // The point of a retag: sync-ssm reads shared/ through the infra scope, so
  // the key has to become visible there with the type it already had.
  it("makes the key visible to the newly listed app with its type intact", () => {
    const { content, moved } = rescopeVariableLine({
      content: sharedContent,
      directive: "# @apps: api, app, scripts, infra",
      key: "STRIPE_SECRET_KEY",
    });

    expect(moved).toBe(true);
    expect(visibleKeys(content, "infra")).toContain("STRIPE_SECRET_KEY");
    expect(
      parseSSMTypeAnnotations(content, "infra").get("STRIPE_SECRET_KEY")
    ).toBe("SecureString");
    expect(parseEnvContent(content).STRIPE_SECRET_KEY).toBe("sk_test_secret");
  });

  // A retag edits one key's audience; widening the whole old block would
  // quietly ship its neighbours to apps that never asked for them.
  it("leaves the other variables in the old block with their old scope and type", () => {
    const { content } = rescopeVariableLine({
      content: sharedContent,
      directive: "# @apps: api, app, scripts, infra",
      key: "STRIPE_SECRET_KEY",
    });

    expect(visibleKeys(content, "infra")).not.toContain("ADMIN_EMAILS");
    expect(visibleKeys(content, "api")).toContain("ADMIN_EMAILS");
    expect(visibleKeys(content, "web")).toContain("NEXT_PUBLIC_APP_URL");
    expect(parseSSMTypeAnnotations(content).get("ADMIN_EMAILS")).toBe("String");
  });

  it("removes the old definition and annotation instead of leaving a duplicate behind", () => {
    const { content } = rescopeVariableLine({
      content: sharedContent,
      directive: "# @apps: api",
      key: "STRIPE_SECRET_KEY",
    });

    expect(content.match(/^STRIPE_SECRET_KEY=/gmu)).toHaveLength(1);
    expect(content.match(/^# SecureString$/gmu)).toHaveLength(1);
  });

  it("narrows a key out of an app's view as well as widening it", () => {
    const { content } = rescopeVariableLine({
      content: sharedContent,
      directive: "# @apps: api",
      key: "NEXT_PUBLIC_APP_URL",
    });

    expect(visibleKeys(content, "web")).not.toContain("NEXT_PUBLIC_APP_URL");
    expect(visibleKeys(content, "api")).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("reports nothing moved and leaves the content alone when the key is absent", () => {
    const result = rescopeVariableLine({
      content: sharedContent,
      directive: "# @apps: infra",
      key: "MISSING_KEY",
    });

    expect(result).toStrictEqual({ content: sharedContent, moved: false });
  });
});

const targetApp = (name: string): AppConfig => ({
  directory: `apps/${name}`,
  name,
  type: "vercel",
});

const apps = ["api", "app", "infra"].map(targetApp);

describe(chooseHome, () => {
  // One reader needs no tag: its own file is already its audience.
  it("keeps a single-target variable in that target's own folder", () => {
    expect(
      chooseHome({ allApps: apps, targets: new Set(["api"]) })
    ).toMatchObject({ destination: "api" });
  });

  it("shares a multi-target variable from shared/ with a tag", () => {
    expect(
      chooseHome({ allApps: apps, targets: new Set(["api", "infra"]) })
    ).toStrictEqual({
      destination: "shared",
      directive: "# @apps: api, infra",
    });
  });
});

describe(variableAudience, () => {
  it("counts a target folder as its own audience and shared/ by its tag", () => {
    const audience = variableAudience({
      allApps: apps,
      contents: {
        api: 'CRON_SECRET="x"',
        shared: ["# @apps: app, infra", 'CRON_SECRET="x"'].join("\n"),
      },
      key: "CRON_SECRET",
    });

    expect([...audience].toSorted()).toStrictEqual(["api", "app", "infra"]);
  });
});

describe(planRescope, () => {
  const key = "CRON_SECRET";

  const apiFile = ["# SecureString", 'CRON_SECRET="s3"', 'OTHER="o"'].join(
    "\n"
  );

  const sharedFile = ['NEXT_PUBLIC_APP_URL="u"', ""].join("\n");

  // The CRON_SECRET bug: it lives in api/ only, and widening it must move it
  // to shared/ with its tag and type rather than refusing.
  it("widening an app-file variable moves it to shared/ with tag and type, out of the app file", () => {
    const result = planRescope({
      contents: { api: apiFile, shared: sharedFile },
      destination: "shared",
      directive: "# @apps: api, infra",
      key,
    });

    if (!("changes" in result)) {
      throw new Error("expected changes");
    }

    expect(result.changes.shared).toContain(
      ["# @apps: api, infra", "# SecureString", 'CRON_SECRET="s3"'].join("\n")
    );
    expect(result.changes.api).not.toContain("CRON_SECRET");
    expect(result.changes.api).not.toContain("# SecureString");
    expect(result.changes.api).toContain('OTHER="o"');
  });

  it("narrowing a shared variable to one target moves it into that target's file", () => {
    const shared = [
      "# @apps: api, infra",
      "# SecureString",
      'CRON_SECRET="s3"',
    ].join("\n");

    const result = planRescope({
      contents: { api: 'OTHER="o"', shared },
      destination: "api",
      directive: "# @apps: api",
      key,
    });

    if (!("changes" in result)) {
      throw new Error("expected changes");
    }

    expect(result.changes.api).toContain('CRON_SECRET="s3"');
    expect(result.changes.api).toContain("# SecureString");
    expect(result.changes.api).not.toContain("@apps");
    expect(result.changes.shared).not.toContain("CRON_SECRET");
  });

  // Merging two different secrets would silently drop one of them.
  it("reports a conflict and changes nothing when the destination holds another value", () => {
    const result = planRescope({
      contents: { api: 'CRON_SECRET="old"', shared: 'CRON_SECRET="new"' },
      destination: "shared",
      directive: "# @apps: api, infra",
      key,
    });

    expect(result).toHaveProperty("conflict");
    expect(result).not.toHaveProperty("changes");
  });

  it("dedupes when the destination already holds the same value", () => {
    const result = planRescope({
      contents: { api: 'CRON_SECRET="same"', shared: 'CRON_SECRET="same"' },
      destination: "shared",
      directive: "# @apps: api, infra",
      key,
    });

    if (!("changes" in result)) {
      throw new Error("expected changes");
    }

    expect(result.changes.shared.match(/^CRON_SECRET=/gmu)).toHaveLength(1);
    expect(result.changes.api).not.toContain("CRON_SECRET");
  });

  it("leaves a variable alone when it is already in its single target's file", () => {
    expect(
      planRescope({
        contents: { api: apiFile },
        destination: "api",
        directive: "# @apps: api",
        key,
      })
    ).toStrictEqual({ changes: {} });
  });
});

const build = () => ({
  encrypt: vi.fn<WriteChangesDependencies["encrypt"]>(),
  removeFile: vi.fn<WriteChangesDependencies["removeFile"]>(),
  writeFile: vi.fn<WriteChangesDependencies["writeFile"]>(),
});

describe(writeChanges, () => {
  const files = new Map([
    ["api", { content: "", encPath: "api.enc", plaintextPath: "api.env" }],
  ]);

  // sops cannot encrypt an empty dotenv, so a file whose last variable moved
  // away is deleted; every reader already treats a missing file as empty.
  it("deletes the file instead of encrypting when no variables are left", async () => {
    const dependencies = build();

    await writeChanges({
      changes: { api: "# only a comment\n" },
      dependencies,
      environment: "production",
      files,
    });

    expect(dependencies.encrypt).not.toHaveBeenCalled();
    expect(dependencies.removeFile).toHaveBeenCalledWith("api.enc");
  });

  it("encrypts a file that still has variables", async () => {
    const dependencies = build();

    await writeChanges({
      changes: { api: 'OTHER="o"\n' },
      dependencies,
      environment: "production",
      files,
    });

    expect(dependencies.encrypt).toHaveBeenCalledWith("api.env", "api.enc");
    expect(dependencies.removeFile).not.toHaveBeenCalled();
  });
});

describe(findVariableScope, () => {
  it("reports the scope of the definition that wins when a key is defined twice", () => {
    const content = [
      "# @apps: api",
      'CRON_SECRET="old"',
      "# @apps: api, infra",
      'CRON_SECRET="new"',
    ].join("\n");

    expect(findVariableScope({ content, key: "CRON_SECRET" })).toStrictEqual([
      "api",
      "infra",
    ]);
  });

  it("treats a key above every directive as global", () => {
    expect(
      findVariableScope({
        content: 'NEXT_PUBLIC_APP_URL="x"',
        key: "NEXT_PUBLIC_APP_URL",
      })
    ).toBe("global");
  });
});
