import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvContext } from "../config";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { SopsService } from "../services/sops.service";
import { output } from "../utils/cli-output";
import { setupApp } from "./setup-local";

describe(setupApp, () => {
  let root = "";
  let plaintextPath = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "setup-local-"));
    setEnvContext({
      config: { envDir: "env", externallyManagedKeys: [] },
      root,
    });

    await mkdir(path.join(root, "env", "web"), { recursive: true });
    plaintextPath = path.join(root, "env", "web", ".env.staging");
    await writeFile(plaintextPath, 'UNENCRYPTED_EDIT="keep me"\n');

    vi.spyOn(AppDiscoveryService, "getAppConfig").mockResolvedValue({
      name: "web",
      type: "vercel",
    });

    for (const method of ["info", "success", "warning"] as const) {
      vi.spyOn(output, method).mockReturnValue(undefined);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
  });

  // The plaintext file can hold edits `encrypt` has not picked up yet.
  it("keeps the existing plaintext file when the app's .enc fails to decrypt", async () => {
    await writeFile(`${plaintextPath}.enc`, "ciphertext");
    vi.spyOn(SopsService, "decrypt").mockRejectedValue(
      new Error("AccessDeniedException")
    );

    await setupApp("web", "staging");

    await expect(readFile(plaintextPath, "utf-8")).resolves.toBe(
      'UNENCRYPTED_EDIT="keep me"\n'
    );
  });

  it("keeps the existing plaintext file when the app has no .enc", async () => {
    await setupApp("web", "staging");

    await expect(readFile(plaintextPath, "utf-8")).resolves.toBe(
      'UNENCRYPTED_EDIT="keep me"\n'
    );
  });

  it("writes the decrypted content over the plaintext file", async () => {
    await writeFile(`${plaintextPath}.enc`, "ciphertext");
    vi.spyOn(SopsService, "decrypt").mockResolvedValue('FRESH="value"\n');

    await setupApp("web", "staging");

    await expect(readFile(plaintextPath, "utf-8")).resolves.toBe(
      'FRESH="value"\n'
    );
  });
});
