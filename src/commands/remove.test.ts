import { describe, expect, it } from "vitest";

import { EnvFilterService } from "../services/env-filter.service";
import type { AppConfig } from "../types/app-config.types";
import { planRemoval, removeVariableLines } from "./remove";
import { variableAudience } from "./update";
import type { LoadedEnvironment } from "./update";

const app = (name: string): AppConfig => ({
  directory: `apps/${name}`,
  name,
  type: "vercel",
});

const allApps = ["app", "infra", "web"].map(app);

const loadedFrom = (contents: Record<string, string>): LoadedEnvironment => ({
  audience: variableAudience({
    allApps,
    contents,
    key: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  }),
  environment: "production",
  files: new Map(
    Object.entries(contents).map(([directory, content]) => [
      directory,
      {
        content,
        encPath: `${directory}.enc`,
        plaintextPath: directory,
      },
    ])
  ),
});

describe(planRemoval, () => {
  const sharedContent = [
    "# @apps: app, web",
    "# String",
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY="site"',
    "",
  ].join("\n");

  // The reason the prompt asks about apps, not files: removing the key from
  // `web` when `app` was meant breaks apps/web/env.ts. Naming `app` must leave
  // `web` still seeing it, in its own file now that it is the only reader.
  it("narrowing a shared variable to one app moves it into that app's file", async () => {
    const plan = await planRemoval({
      allApps,
      key: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      loaded: loadedFrom({ shared: sharedContent, web: 'OTHER="x"' }),
      removed: new Set(["app"]),
    });

    expect(plan?.isRetired).toBe(false);
    const changes = plan && "changes" in plan.result ? plan.result.changes : {};
    expect(changes.web).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY="site"');
    expect(changes.web).toContain("# String");
    expect(changes.web).toContain('OTHER="x"');
    expect(changes.shared).not.toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  });

  it("removing every reader deletes the variable and marks it retired", async () => {
    const plan = await planRemoval({
      allApps,
      key: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      loaded: loadedFrom({ shared: sharedContent }),
      removed: new Set(["app", "web"]),
    });

    expect(plan?.isRetired).toBe(true);
    const changes = plan && "changes" in plan.result ? plan.result.changes : {};
    expect(changes.shared).not.toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  });

  // Remote Vercel/SSM cleanup is only valid once nobody reads the variable.
  it("does not mark a still-read variable as retired", async () => {
    const plan = await planRemoval({
      allApps,
      key: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      loaded: loadedFrom({
        shared: sharedContent.replace("app, web", "app, infra, web"),
      }),
      removed: new Set(["infra"]),
    });

    expect(plan?.isRetired).toBe(false);
  });

  it("skips an environment where none of the removed apps saw the variable", async () => {
    const plan = await planRemoval({
      allApps,
      key: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      loaded: loadedFrom({ infra: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY="x"' }),
      removed: new Set(["web"]),
    });

    expect(plan).toBeNull();
  });
});

describe(removeVariableLines, () => {
  const directivesContent = [
    "# @apps: api, app",
    "# SecureString",
    'STRIPE_WEBHOOK_SECRET="whsec_dead"',
    "",
    "# @global",
    "# String",
    'NEXT_PUBLIC_APP_URL="https://example.test"',
    "",
  ].join("\n");

  // The directives describe the variable being removed and nothing else.
  // Leaving them behind would park them above an unrelated variable, where
  // they would misdescribe who sees it and how it syncs.
  it("takes the variable's own directives with it", () => {
    const { content: updated, removed } = removeVariableLines({
      content: directivesContent,
      key: "STRIPE_WEBHOOK_SECRET",
    });

    expect(removed).toBe(1);
    expect(updated).not.toContain("STRIPE_WEBHOOK_SECRET");
    expect(updated).not.toContain("# @apps: api, app");
    expect(updated).not.toContain("# SecureString");
  });

  it("leaves the neighbouring variable's directives in place", () => {
    const { content: updated } = removeVariableLines({
      content: directivesContent,
      key: "STRIPE_WEBHOOK_SECRET",
    });

    expect(updated).toContain("# @global");
    expect(updated).toContain("# String");
    expect(updated).toContain('NEXT_PUBLIC_APP_URL="https://example.test"');
  });

  // `env add` on an existing key appends a second definition, so a file can
  // legitimately hold duplicates. Retiring the variable has to clear all of
  // them or the dead value survives.
  it("removes every definition, not just the first", () => {
    const content = [
      'DEAD_KEY="one"',
      "# @apps: api",
      "# SecureString",
      'DEAD_KEY="two"',
      'KEPT="value"',
    ].join("\n");

    const { content: updated, removed } = removeVariableLines({
      content,
      key: "DEAD_KEY",
    });

    expect(removed).toBe(2);
    expect(updated).not.toContain("DEAD_KEY");
    expect(updated).toContain('KEPT="value"');
  });

  it("does not touch a variable that merely shares a prefix", () => {
    const content = ['DEAD_KEY_OLD="keep"', 'DEAD_KEY="remove"'].join("\n");

    const { content: updated, removed } = removeVariableLines({
      content,
      key: "DEAD_KEY",
    });

    expect(removed).toBe(1);
    expect(updated).toContain('DEAD_KEY_OLD="keep"');
    expect(updated).not.toContain('DEAD_KEY="remove"');
  });

  it("reports nothing removed when the variable is absent", () => {
    const { content, removed } = removeVariableLines({
      content: 'OTHER="value"\n',
      key: "DEAD_KEY",
    });

    expect(removed).toBe(0);
    expect(content).toContain('OTHER="value"');
  });

  // The `# @apps:` line scopes the whole block. Dropping it with the first
  // variable would leave its neighbours inheriting the previous block's scope
  // (or none), silently shipping them to the wrong apps.
  it("keeps the block's scope line for the variables that remain in it", () => {
    const content = [
      "# @apps: api",
      "# String",
      'FIRST="1"',
      "# String",
      'SECOND="2"',
      "",
      "# @global",
      "# String",
      'THIRD="3"',
      "",
    ].join("\n");

    const { content: updated } = removeVariableLines({
      content,
      key: "FIRST",
    });

    expect(
      EnvFilterService.filterForApp(updated, "web").map(({ key }) => key)
    ).toStrictEqual(["THIRD"]);
    expect(
      EnvFilterService.filterForApp(updated, "api").map(({ key }) => key)
    ).toStrictEqual(["SECOND", "THIRD"]);
    expect(updated).not.toContain("FIRST");
  });

  it("drops the scope line once the block has no variables left", () => {
    const content = [
      "# @apps: api",
      "# String",
      'ONLY="1"',
      "",
      "# @global",
      'OTHER="2"',
    ].join("\n");

    const { content: updated } = removeVariableLines({ content, key: "ONLY" });

    expect(updated).not.toContain("@apps: api");
    expect(updated).toContain('OTHER="2"');
  });

  // A variable with no directives above it must not eat the line before it.
  it("leaves a preceding ordinary variable alone", () => {
    const content = ['FIRST="one"', 'DEAD_KEY="two"', 'LAST="three"'].join(
      "\n"
    );

    const { content: updated } = removeVariableLines({
      content,
      key: "DEAD_KEY",
    });

    expect(updated).toContain('FIRST="one"');
    expect(updated).toContain('LAST="three"');
    expect(updated).not.toContain("DEAD_KEY");
  });
});
