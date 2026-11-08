import { createRequire } from "node:module";
import path from "node:path";

import { z } from "zod";

const singleBinSchema = z.object({ bin: z.string() });
const binMapSchema = z.object({ bin: z.record(z.string(), z.string()) });

const requireFromScripts = createRequire(import.meta.url);

/**
 * Absolute path to a CLI entry of a package installed for apps/scripts, to run
 * as `node <path>` — the pinned version, with no PATH lookup or `.bin` shim
 * (which is a `.cmd` file on Windows).
 */
export const resolvePackageBin = (
  packageName: string,
  binName = packageName
): string => {
  const packageJsonPath = requireFromScripts.resolve(
    `${packageName}/package.json`
  );

  const packageJson: unknown = requireFromScripts(packageJsonPath);
  const singleBin = singleBinSchema.safeParse(packageJson);

  const relativeBinPath = singleBin.success
    ? singleBin.data.bin
    : binMapSchema.parse(packageJson).bin[binName];

  if (!relativeBinPath) {
    throw new Error(`${packageName} has no "${binName}" bin entry`);
  }

  return path.resolve(path.dirname(packageJsonPath), relativeBinPath);
};
