import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyLocation } from "../utils/variable-locations";
import { updateByFlags } from "./update";
import type { UpdateByFlagsDependencies } from "./update";

const KEY = "AWS_SES_IDENTITY_ARN";

const authenticate = vi.fn<UpdateByFlagsDependencies["authenticate"]>();

const collectKeyLocations =
  vi.fn<UpdateByFlagsDependencies["collectKeyLocations"]>();

const refreshLocalDecryptedFiles =
  vi.fn<UpdateByFlagsDependencies["refreshLocalDecryptedFiles"]>();

const rewriteLocation = vi.fn<UpdateByFlagsDependencies["rewriteLocation"]>();
const syncEnvironments = vi.fn<UpdateByFlagsDependencies["syncEnvironments"]>();
const updateApps = vi.fn<UpdateByFlagsDependencies["updateApps"]>();

const dependencies: UpdateByFlagsDependencies = {
  authenticate,
  collectKeyLocations,
  readValue: () => Promise.resolve("arn:aws:ses:eu-west-1:1:identity/x\n"),
  refreshLocalDecryptedFiles,
  rewriteLocation,
  syncEnvironments,
  updateApps,
};

const locate = (...locations: KeyLocation[]) =>
  collectKeyLocations.mockResolvedValue(new Map([[KEY, locations]]));

const expectNothingTouched = (): void => {
  expect(authenticate).not.toHaveBeenCalled();
  expect(rewriteLocation).not.toHaveBeenCalled();
  expect(syncEnvironments).not.toHaveBeenCalled();
};

describe(updateByFlags, () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rewriteLocation.mockResolvedValue(1);
    syncEnvironments.mockResolvedValue(false);
  });

  // Runbooks and agents can't answer prompts, so the flags alone must reach the file.
  it("rewrites the one copy per environment from stdin, then pushes when asked", async () => {
    locate(
      { directory: "web", environment: "staging" },
      { directory: "web", environment: "preview" }
    );

    const hasSyncFailed = await updateByFlags({
      dependencies,
      flags: { env: ["staging,preview"], push: true, valueStdin: true },
      key: KEY,
    });

    expect(hasSyncFailed).toBe(false);
    expect(rewriteLocation).toHaveBeenCalledTimes(2);
    expect(rewriteLocation).toHaveBeenCalledWith({
      directory: "web",
      environment: "staging",
      key: KEY,
      value: "arn:aws:ses:eu-west-1:1:identity/x",
    });
    expect(syncEnvironments).toHaveBeenCalledExactlyOnceWith({
      dryRun: false,
      environments: ["staging", "preview"],
      shouldSyncSSM: true,
      shouldSyncVercel: true,
    });
  });

  it("does not push without --push", async () => {
    locate({ directory: "web", environment: "staging" });

    await updateByFlags({
      dependencies,
      flags: { env: ["staging"], value: "v" },
      key: KEY,
    });

    expect(rewriteLocation).toHaveBeenCalledOnce();
    expect(syncEnvironments).not.toHaveBeenCalled();
  });

  // Rewriting both copies would silently hide which one the caller meant.
  it("refuses a key with several copies until --target picks one, and then rewrites only that copy", async () => {
    locate(
      { directory: "shared", environment: "staging" },
      { directory: "web", environment: "staging" }
    );

    await expect(
      updateByFlags({
        dependencies,
        flags: { env: ["staging"], value: "v" },
        key: KEY,
      })
    ).rejects.toThrow("pass --target");
    expect(rewriteLocation).not.toHaveBeenCalled();

    await updateByFlags({
      dependencies,
      flags: { env: ["staging"], target: "shared", value: "v" },
      key: KEY,
    });

    expect(rewriteLocation).toHaveBeenCalledExactlyOnceWith({
      directory: "shared",
      environment: "staging",
      key: KEY,
      value: "v",
    });
  });

  it("changes the audience from --to with --apps", async () => {
    locate({ directory: "shared", environment: "staging" });
    updateApps.mockResolvedValue(["staging"]);

    await updateByFlags({
      dependencies,
      flags: { apps: true, env: ["staging"], to: "api, web" },
      key: KEY,
    });

    expect(updateApps).toHaveBeenCalledExactlyOnceWith({
      key: KEY,
      locations: [{ directory: "shared", environment: "staging" }],
      targetNames: ["api", "web"],
    });
    expect(rewriteLocation).not.toHaveBeenCalled();
  });

  // A prompt fallback would hang an unattended run; each of these must fail first.
  it.each([
    [{ valueStdin: true }, "--env is required"],
    [{ env: ["staging"] }, "exactly one of --value or --value-stdin"],
    [{ env: ["stagin"], value: "v" }, "Unknown environment stagin"],
    [{ env: ["staging"], to: "web", value: "v" }, "--to only applies"],
    [{ apps: true, env: ["staging"] }, "--apps needs --to"],
    [
      { apps: true, env: ["staging"], to: "web", value: "v" },
      "--apps takes --to",
    ],
  ])("refuses %o before touching anything", async (flags, message) => {
    await expect(
      updateByFlags({ dependencies, flags, key: KEY })
    ).rejects.toThrow(message);
    expectNothingTouched();
  });

  it("refuses an environment where the key is not defined", async () => {
    locate({ directory: "web", environment: "staging" });

    await expect(
      updateByFlags({
        dependencies,
        flags: { env: ["staging", "preview"], value: "v" },
        key: KEY,
      })
    ).rejects.toThrow(`${KEY} is not defined in preview`);
    expect(rewriteLocation).not.toHaveBeenCalled();
  });

  // Production has no prompt to catch a wrong --env, so it needs its own flag.
  it("refuses production without --confirm-production, and writes it with the flag", async () => {
    locate({ directory: "web", environment: "production" });

    await expect(
      updateByFlags({
        dependencies,
        flags: { env: ["production"], value: "v" },
        key: KEY,
      })
    ).rejects.toThrow("--confirm-production");
    expectNothingTouched();

    await updateByFlags({
      dependencies,
      flags: { confirmProduction: true, env: ["production"], value: "v" },
      key: KEY,
    });

    expect(rewriteLocation).toHaveBeenCalledOnce();
  });
});
