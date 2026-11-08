import { beforeEach, describe, expect, it, vi } from "vitest";

import { removeByFlags } from "./remove";
import type { RemoveByFlagsDependencies } from "./remove";
import type { LoadedEnvironment } from "./update";

const KEY = "STRIPE_WEBHOOK_SECRET";

const authenticate = vi.fn<RemoveByFlagsDependencies["authenticate"]>();

const collectKeyLocations =
  vi.fn<RemoveByFlagsDependencies["collectKeyLocations"]>();

const loadEnvironments = vi.fn<RemoveByFlagsDependencies["loadEnvironments"]>();

const refresh =
  vi.fn<RemoveByFlagsDependencies["refreshLocalDecryptedFiles"]>();

const removeFromSSM = vi.fn<RemoveByFlagsDependencies["removeFromSSM"]>();
const removeFromVercel = vi.fn<RemoveByFlagsDependencies["removeFromVercel"]>();
const writeChanges = vi.fn<RemoveByFlagsDependencies["writeChanges"]>();

const dependencies: RemoveByFlagsDependencies = {
  authenticate,
  collectKeyLocations,
  getAllApps: () => Promise.resolve([]),
  loadEnvironments,
  refreshLocalDecryptedFiles: refresh,
  removeFromSSM,
  removeFromVercel,
  writeChanges,
};

const file = (directory: string) => ({
  content: `# @apps: web\n# String\n${KEY}="x"\nOTHER="y"\n`,
  encPath: `${directory}.enc`,
  plaintextPath: directory,
});

const stagingIn = (...directories: string[]): LoadedEnvironment => ({
  audience: new Set(directories),
  environment: "staging",
  files: new Map(directories.map((directory) => [directory, file(directory)])),
});

const define = (loaded: LoadedEnvironment) => {
  const locations = [...loaded.files.keys()].map((directory) => ({
    directory,
    environment: loaded.environment,
  }));

  collectKeyLocations.mockResolvedValue(new Map([[KEY, locations]]));
  loadEnvironments.mockResolvedValue([loaded]);
};

describe(removeByFlags, () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // The stale shared/ copies of a key are removed while the app's own copy keeps working.
  it("removes only --target's copy and leaves the remote alone while another copy remains", async () => {
    define(stagingIn("shared", "web"));

    await removeByFlags({
      dependencies,
      flags: { env: ["staging"], push: true, target: "shared" },
      key: KEY,
    });

    expect(writeChanges).toHaveBeenCalledOnce();

    const [[{ changes }]] = writeChanges.mock.calls;

    expect(Object.keys(changes)).toStrictEqual(["shared"]);
    expect(changes.shared).not.toContain(KEY);
    expect(changes.shared).toContain('OTHER="y"');
    expect(removeFromVercel).not.toHaveBeenCalled();
  });

  it("retires the key everywhere and deletes it remotely only with --push", async () => {
    define(stagingIn("shared", "web"));

    await removeByFlags({
      dependencies,
      flags: { env: ["staging"] },
      key: KEY,
    });

    expect(Object.keys(writeChanges.mock.calls[0][0].changes)).toStrictEqual([
      "shared",
      "web",
    ]);
    expect(removeFromVercel).not.toHaveBeenCalled();

    await removeByFlags({
      dependencies,
      flags: { env: ["staging"], push: true },
      key: KEY,
    });

    expect(removeFromVercel).toHaveBeenCalledExactlyOnceWith({
      dryRun: false,
      environments: ["staging"],
      key: KEY,
    });
  });

  it("refuses a --target the key has no copy in, without writing", async () => {
    define(stagingIn("web"));

    await expect(
      removeByFlags({
        dependencies,
        flags: { env: ["staging"], target: "shared" },
        key: KEY,
      })
    ).rejects.toThrow("no copy in shared/");
    expect(writeChanges).not.toHaveBeenCalled();
  });

  // No prompt exists to ask which environment was meant.
  it("refuses a missing --env before authenticating", async () => {
    await expect(
      removeByFlags({ dependencies, flags: {}, key: KEY })
    ).rejects.toThrow("--env is required");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("refuses production without --confirm-production", async () => {
    await expect(
      removeByFlags({
        dependencies,
        flags: { env: ["staging,production"] },
        key: KEY,
      })
    ).rejects.toThrow("--confirm-production");
    expect(authenticate).not.toHaveBeenCalled();
    expect(writeChanges).not.toHaveBeenCalled();
  });
});
