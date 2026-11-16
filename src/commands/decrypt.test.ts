import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvContext } from "../config";
import { SopsService } from "../services/sops.service";
import { output } from "../utils/cli-output";
import { decryptEnvironment } from "./decrypt";

describe(decryptEnvironment, () => {
  let root = "";
  let envLocalPath = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "decrypt-"));
    setEnvContext({
      config: { envDir: "env", externallyManagedKeys: [] },
      root,
    });

    await Promise.all(
      ["env/shared", "env/web", "apps/web"].map((directory) =>
        mkdir(path.join(root, directory), { recursive: true })
      )
    );

    await writeFile(path.join(root, "env/shared/.env.development.enc"), "x");
    await writeFile(path.join(root, "env/web/.env.development.enc"), "x");
    envLocalPath = path.join(root, "apps/web/.env.local");
    await writeFile(envLocalPath, 'SHARED_KEY="working"\nAPP_KEY="old"\n');

    for (const method of [
      "debug",
      "error",
      "info",
      "section",
      "success",
    ] as const) {
      vi.spyOn(output, method).mockReturnValue(undefined);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
  });

  // A .env.local without the shared variables breaks an app that was working.
  it("leaves .env.local alone when the shared file failed to decrypt", async () => {
    vi.spyOn(SopsService, "decrypt").mockImplementation((filePath) =>
      filePath.includes("shared")
        ? Promise.reject(new Error("AccessDeniedException"))
        : Promise.resolve('APP_KEY="new"\n')
    );

    const result = await decryptEnvironment(
      "development",
      [{ directory: "apps/web", name: "web", type: "vercel" }],
      true
    );

    expect(result.errorCount).toBe(1);
    await expect(readFile(envLocalPath, "utf-8")).resolves.toBe(
      'SHARED_KEY="working"\nAPP_KEY="old"\n'
    );
  });
});
