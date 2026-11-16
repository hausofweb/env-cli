import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageBin } from "./package-bin";

describe(resolvePackageBin, () => {
  it("resolves the vercel CLI installed beside this package, not a global one on PATH", () => {
    // `vercel login` must run the installed version so auth behaves the same
    // on every machine.
    const binPath = resolvePackageBin("vercel");

    expect(existsSync(binPath)).toBe(true);
    expect(path.basename(path.dirname(path.dirname(binPath)))).toBe("vercel");
  });

  it("throws for a bin name the package does not ship", () => {
    expect(() => resolvePackageBin("vercel", "not-a-bin")).toThrow(
      'vercel has no "not-a-bin" bin entry'
    );
  });
});
