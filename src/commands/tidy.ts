import path from "node:path";

import { confirm } from "@inquirer/prompts";
import { Command } from "commander";

import { ENVIRONMENTS } from "../constants/environments";
import { getEnvDir } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { EnvMergeService } from "../services/env-merge.service";
import { SopsService } from "../services/sops.service";
import type { AppConfig, Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import { getEnvFileName } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";
import { isExitPromptError } from "../utils/prompt-errors";
import {
  collectKeyLocations,
  SHARED_DIR_NAME,
} from "../utils/variable-locations";
import type { KeyLocation } from "../utils/variable-locations";
import { refreshLocalDecryptedFiles } from "./add";
import {
  applyPlans,
  loadEnvironments,
  planTargets,
  variableAudience,
} from "./update";

/**
 * The one target that sees a shared/ variable, when there is only one: its
 * `# @apps:` tag plus any target folder that also defines it. Such a variable
 * belongs in that target's own file (the convention `env add` and
 * `env update --apps` follow); anything seen by several stays in shared/.
 */
export const misplacedTarget = ({
  allApps,
  key,
  otherDirectories,
  sharedContent,
}: {
  allApps: AppConfig[];
  key: string;
  /** Target folders that also define `key` in the same environment. */
  otherDirectories: string[];
  /** Decrypted `shared/.env.<environment>` text. */
  sharedContent: string;
}): string | undefined => {
  const audience = variableAudience({
    allApps,
    contents: { [SHARED_DIR_NAME]: sharedContent },
    key,
  });

  for (const directory of otherDirectories) {
    audience.add(directory);
  }

  return audience.size === 1 ? [...audience][0] : undefined;
};

interface MisplacedVariable {
  key: string;
  /** Every file defining `key`, across environments, for `loadEnvironments`. */
  locations: KeyLocation[];
  /** Target that should own `key`, by environment where it sits in shared/. */
  targets: Map<Environment, string>;
}

const findMisplaced = async (
  allApps: AppConfig[]
): Promise<MisplacedVariable[]> => {
  const allLocations = await collectKeyLocations([...ENVIRONMENTS]);
  const found = new Map<string, MisplacedVariable>();

  // sequential: one sops run at a time keeps KMS calls and output in order
  await mapSequentially([...ENVIRONMENTS], async (environment) => {
    const encPath = path.join(
      getEnvDir(),
      SHARED_DIR_NAME,
      `${getEnvFileName(environment)}.enc`
    );

    if (!(await FileOperations.fileExists(encPath))) {
      return;
    }

    const sharedContent = await SopsService.decrypt(encPath);

    for (const key of EnvMergeService.extractKeys(sharedContent)) {
      const locations = allLocations.get(key) ?? [];

      const otherDirectories = locations.flatMap((location) =>
        location.environment === environment &&
        location.directory !== SHARED_DIR_NAME
          ? [location.directory]
          : []
      );

      const target = misplacedTarget({
        allApps,
        key,
        otherDirectories,
        sharedContent,
      });

      if (target === undefined) {
        continue;
      }

      const entry = found.get(key) ?? { key, locations, targets: new Map() };
      entry.targets.set(environment, target);
      found.set(key, entry);
    }
  });

  return [...found.values()].toSorted((a, b) => a.key.localeCompare(b.key));
};

/**
 * Re-reads and moves one variable. Read just before writing, not at scan time:
 * moving an earlier variable has already rewritten the same shared/ files.
 * Returns the environments whose files changed.
 */
const moveVariable = async ({
  allApps,
  misplaced: { key, locations, targets },
}: {
  allApps: AppConfig[];
  misplaced: MisplacedVariable;
}): Promise<Environment[]> => {
  const loaded = await loadEnvironments({ allApps, key, locations });

  const plans = await mapSequentially(
    loaded.filter(({ environment }) => targets.has(environment)),
    (environment) =>
      planTargets({
        allApps,
        key,
        loaded: environment,
        targets: new Set([targets.get(environment.environment) ?? ""]),
      })
  );

  const conflicts = plans.flatMap(({ result }) =>
    "conflict" in result ? [result.conflict] : []
  );

  if (conflicts.length > 0) {
    output.warning(`  Skipped ${key}: ${conflicts.join(" ")}`);

    return [];
  }

  output.section(key);
  await applyPlans(plans);

  return plans.map(({ environment }) => environment);
};

export const tidyCommand = new Command("tidy")
  .description(
    "Move every shared/ variable that only one app sees into that app's own folder"
  )
  .action(async () => {
    try {
      await checkAndAuthenticateAWS();
      SopsService.validateSopsInstalled();

      const allApps = await AppDiscoveryService.getAllApps();
      output.section("Reading every environment");
      const misplaced = await findMisplaced(allApps);

      if (misplaced.length === 0) {
        output.success(
          "Nothing to move: every shared/ variable is seen by several apps."
        );
        process.exit(0);
      }

      output.section("To move");

      for (const { key, targets } of misplaced) {
        const moves = [...targets].map(
          ([environment, target]) => `${environment} → ${target}/`
        );

        output.log(`  ${key}: ${moves.join(", ")}`);
      }

      const proceed = await confirm({
        default: true,
        message: `Move ${misplaced.length} variable(s) out of shared/? Values and types are kept; who sees them does not change.`,
      });

      if (!proceed) {
        output.info("Cancelled.");
        process.exit(0);
      }

      const changed = await mapSequentially(misplaced, (variable) =>
        moveVariable({ allApps, misplaced: variable })
      );

      await refreshLocalDecryptedFiles([...new Set(changed.flat())]);

      output.log("");
      output.success(
        "Done. Every app still sees the same values, so nothing needs syncing."
      );
      process.exit(0);
    } catch (error) {
      if (isExitPromptError(error)) {
        output.info("\nCancelled.");
        process.exit(0);
      }

      if (error instanceof AWSCredentialsError) {
        outputAWSCredentialsError(error);
      } else {
        output.error(error instanceof Error ? error.message : "Tidy failed");
      }

      process.exit(1);
    }
  });
