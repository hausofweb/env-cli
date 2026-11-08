import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getEnvDir } from "../constants/paths";
import { AppDiscoveryService } from "../services/app-discovery.service";
import type { AppConfig } from "../types/app-config.types";
import { output } from "../utils/cli-output";
import { FileOperations } from "../utils/file-operations";
import {
  answersFromFlags,
  buildAppsDirective,
  chooseHome,
  createAddCommandSteps,
  resolveFlagValue,
  variableDirectives,
} from "./add";
import type { decryptEnvironment } from "./decrypt";
import type { handleSyncSSMCommand } from "./sync-ssm";
import type { handleSyncCommand } from "./sync-vercel";

const decryptEnvironmentMock = vi.fn<typeof decryptEnvironment>();
const handleSyncCommandMock = vi.fn<typeof handleSyncCommand>();
const handleSyncSSMCommandMock = vi.fn<typeof handleSyncSSMCommand>();

const { refreshLocalDecryptedFiles, syncEnvironments } = createAddCommandSteps({
  decryptEnvironment: decryptEnvironmentMock,
  handleSyncCommand: handleSyncCommandMock,
  handleSyncSSMCommand: handleSyncSSMCommandMock,
});

const api: AppConfig = { directory: "apps/api", name: "api", type: "vercel" };

const infra: AppConfig = {
  directory: "apps/infra",
  name: "infra",
  type: "non-vercel",
};

const web: AppConfig = { directory: "apps/web", name: "web", type: "vercel" };

describe(buildAppsDirective, () => {
  it("lists non-Vercel apps like infra so decrypt --all can scope them", () => {
    expect(buildAppsDirective([api, infra], [api, infra, web])).toBe(
      "# @apps: api, infra"
    );
  });

  it("collapses to @global when every app is selected", () => {
    expect(buildAppsDirective([web, infra, api], [api, infra, web])).toBe(
      "# @global"
    );
  });
});

describe(variableDirectives, () => {
  // One app owns the variable in env/<app>/, so a tag there would only repeat
  // the folder and drift from it.
  it("writes only the type for a variable one app sees", () => {
    const home = chooseHome({
      allApps: [api, infra, web],
      targets: new Set(["api"]),
    });

    expect(home.destination).toBe("api");
    expect(variableDirectives(home, "SecureString")).toStrictEqual([
      "# SecureString",
    ]);
  });

  it("tags a variable several apps see and keeps it in shared/", () => {
    const home = chooseHome({
      allApps: [api, infra, web],
      targets: new Set(["api", "infra"]),
    });

    expect(home.destination).toBe("shared");
    expect(variableDirectives(home, "String")).toStrictEqual([
      "# @apps: api, infra",
      "# String",
    ]);
  });
});

describe(refreshLocalDecryptedFiles, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptEnvironmentMock.mockResolvedValue({
      errorCount: 0,
      successCount: 0,
    });
    vi.spyOn(AppDiscoveryService, "getAllApps").mockResolvedValue([api, infra]);
    vi.spyOn(FileOperations, "removeFile").mockResolvedValue(undefined);
    vi.spyOn(output, "section").mockReturnValue(undefined);
    vi.spyOn(output, "success").mockReturnValue(undefined);
  });

  it("decrypts development to disk and removes plaintext for every higher environment, selected or not", async () => {
    await refreshLocalDecryptedFiles(["development", "production"]);

    expect(decryptEnvironmentMock).toHaveBeenCalledExactlyOnceWith(
      "development",
      [api, infra],
      true
    );

    const removed = vi
      .mocked(FileOperations.removeFile)
      .mock.calls.map(([filePath]) => filePath);

    const expected = ["production", "staging", "preview"].flatMap((env) =>
      ["shared", "api", "infra"].map((dir) =>
        path.join(getEnvDir(), dir, `.env.${env}`)
      )
    );

    expect(removed).toHaveLength(expected.length);
    expect(new Set(removed)).toStrictEqual(new Set(expected));
    expect(removed).not.toContainEqual(expect.stringContaining("development"));
  });

  it("does not decrypt development when it was not selected", async () => {
    await refreshLocalDecryptedFiles(["staging"]);

    expect(decryptEnvironmentMock).not.toHaveBeenCalled();
  });
});

describe(syncEnvironments, () => {
  const calls: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    handleSyncCommandMock.mockImplementation((environment) => {
      calls.push(`vercel:${environment}`);

      return Promise.resolve(environment === "staging");
    });
    handleSyncSSMCommandMock.mockImplementation((environment) => {
      calls.push(`ssm:${environment}`);

      return Promise.resolve(false);
    });
  });

  it("syncs each environment in order, Vercel before SSM, and still runs SSM after a Vercel failure", async () => {
    // add/update report one combined result, so a Vercel failure must not hide
    // (or skip) the SSM sync for the same or later environments.
    const hasFailure = await syncEnvironments({
      dryRun: true,
      environments: ["staging", "preview"],
      shouldSyncSSM: true,
      shouldSyncVercel: true,
    });

    expect(hasFailure).toBe(true);
    expect(calls).toStrictEqual([
      "vercel:staging",
      "ssm:staging",
      "vercel:preview",
      "ssm:preview",
    ]);
    expect(handleSyncCommandMock).toHaveBeenCalledWith("staging", {
      dryRun: true,
    });
    expect(handleSyncSSMCommandMock).toHaveBeenCalledWith("preview", {
      dryRun: true,
    });
  });

  it("skips targets that were not requested and reports success when nothing failed", async () => {
    const hasFailure = await syncEnvironments({
      dryRun: false,
      environments: ["staging", "preview"],
      shouldSyncSSM: true,
      shouldSyncVercel: false,
    });

    expect(hasFailure).toBe(false);
    expect(calls).toStrictEqual(["ssm:staging", "ssm:preview"]);
  });
});

describe(resolveFlagValue, () => {
  // `terraform output | jq -r … | env add KEY --value-stdin` ends with jq's newline;
  // storing it would corrupt a token that the app sends verbatim in a header.
  it("drops the one trailing newline a pipe adds, and nothing else", async () => {
    const value = await resolveFlagValue({
      flags: { valueStdin: true },
      readValue: () => Promise.resolve("  abc.def \n"),
    });

    expect(value).toBe("  abc.def ");
  });

  // Two sources would leave it unclear which one was stored.
  it("refuses both --value and --value-stdin", async () => {
    await expect(
      resolveFlagValue({
        flags: { value: "a", valueStdin: true },
        readValue: () => Promise.resolve("b"),
      })
    ).rejects.toThrow("exactly one");
  });

  it("refuses neither, rather than falling back to a prompt", async () => {
    await expect(resolveFlagValue({ flags: {} })).rejects.toThrow(
      "exactly one"
    );
  });

  // An empty pipe (a failed `terraform output`) must not store an empty secret.
  it("refuses an empty value", async () => {
    await expect(
      resolveFlagValue({
        flags: { valueStdin: true },
        readValue: () => Promise.resolve("\n"),
      })
    ).rejects.toThrow("empty");
  });
});

describe(answersFromFlags, () => {
  const allApps = [api, infra, web];

  it("builds the same answers the wizard would, with the value in every environment", () => {
    const answers = answersFromFlags({
      allApps,
      flags: { apps: "api, web", env: "development,staging", type: "String" },
      key: "API_PROXY_UPSTREAM_URL",
      value: "https://example.test",
    });

    expect(answers).toStrictEqual({
      apps: [api, web],
      environments: ["development", "staging"],
      key: "API_PROXY_UPSTREAM_URL",
      type: "String",
      values: new Map([
        ["development", "https://example.test"],
        ["staging", "https://example.test"],
      ]),
    });
  });

  // Omitting --type must never publish a secret as a readable String.
  it("defaults to SecureString", () => {
    const answers = answersFromFlags({
      allApps,
      flags: { apps: "web", env: "development" },
      key: "CF_ACCESS_CLIENT_SECRET",
      value: "s",
    });

    expect(answers.type).toBe("SecureString");
  });

  // A typo would otherwise write a file nothing reads, or give the variable to the wrong app.
  it.each([
    [{ apps: "web", env: "devlopment" }, "Unknown environment devlopment"],
    [{ apps: "wbe", env: "development" }, "Unknown app wbe"],
    [{ apps: "web", env: "development", type: "Secure" }, "--type must be"],
    [{ apps: "web" }, "--env is required"],
    [{ apps: " , ", env: "development" }, "--apps is required"],
  ])("refuses %o", (flags, message) => {
    expect(() =>
      answersFromFlags({ allApps, flags, key: "SOME_KEY", value: "v" })
    ).toThrow(message);
  });

  it("refuses a key the wizard would refuse", () => {
    expect(() =>
      answersFromFlags({
        allApps,
        flags: { apps: "web", env: "development" },
        key: "cf_access_client_id",
        value: "v",
      })
    ).toThrow("SCREAMING_SNAKE_CASE");
  });
});
