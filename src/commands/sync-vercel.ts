import path from "node:path";

import { confirm as defaultConfirm } from "@inquirer/prompts";
import { Command } from "commander";

import { isExternallyManagedKey } from "../config";
import { ENVIRONMENTS } from "../constants/environments";
import { getEnvDir } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { EnvFilterService } from "../services/env-filter.service";
import { EnvMergeService } from "../services/env-merge.service";
import { SopsService } from "../services/sops.service";
import { VercelService } from "../services/vercel.service";
import type { VercelExistingVariable } from "../services/vercel.service";
import type { AppConfig, Environment } from "../types/app-config.types";
import type { EnvVariable } from "../types/env-file.types";
import { VercelError } from "../types/vercel-error";
import type { VercelSyncResult } from "../types/vercel.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import { getEnvFileName, parseSSMTypeAnnotations } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";
import { isExitPromptError } from "../utils/prompt-errors";

const UNKNOWN_ERROR = "Unknown error";

/**
 * "report" lists what the encrypted files no longer define; "apply" also
 * deletes it, after a confirm prompt per project and environment.
 */
type PruneMode = "off" | "report" | "apply";

interface SyncOptions {
  /** Report the Vercel env changes without applying them. */
  dryRun: boolean;
  /** Whether to list, or list and remove, variables the files don't define. */
  prune: PruneMode;
}

/** Variable counts summed across every Vercel-linked app for one environment. */
interface SyncResult {
  /** Apps whose whole sync threw (e.g. a `VercelError`), not per-variable. */
  errorCount: number;
  /** Variables created in Vercel (or that would be, in dry-run). */
  totalAdded: number;
  /** Individual variables the Vercel API rejected. */
  totalFailed: number;
  /** Stale variables taken out of the environment by `--confirm-prune`. */
  totalPruned: number;
  /** Variables whose synced-value hash comment and type already match. */
  totalSkipped: number;
  /** Existing Vercel variables rewritten with a new value or type. */
  totalUpdated: number;
}

/** Variable counts for one app in one environment. */
interface AppResult {
  /** Variables created in Vercel (or that would be, in dry-run). */
  added: number;
  /** Variables the Vercel API rejected, plus a prune skipped on a failed decrypt. */
  failed: number;
  /** Stale variables taken out of the environment by `--confirm-prune`. */
  pruned: number;
  /** Variables whose synced-value hash comment and type already match. */
  skipped: number;
  /** Existing Vercel variables rewritten with a new value or type. */
  updated: number;
}

const EMPTY_APP_RESULT: AppResult = {
  added: 0,
  failed: 0,
  pruned: 0,
  skipped: 0,
  updated: 0,
};

const VERCEL_SYSTEM_PREFIX = "VERCEL_";

const resolveEnvironments = (environmentArg: string): Environment[] => {
  if (environmentArg === "all") {
    return ENVIRONMENTS;
  }

  const environment = ENVIRONMENTS.find((env) => env === environmentArg);

  if (!environment) {
    throw new Error(
      `Invalid environment: ${environmentArg}. Must be one of: ${ENVIRONMENTS.join(", ")}, all`
    );
  }

  return [environment];
};

const validateEnvironmentAndSetup = async (
  environmentArg: string,
  dryRun: boolean
): Promise<Environment[]> => {
  const envs = resolveEnvironments(environmentArg);

  if (dryRun) {
    output.warning("DRY RUN MODE - No changes will be made\n");
  }

  await checkAndAuthenticateAWS();

  SopsService.validateSopsInstalled();

  return envs;
};

/**
 * Returns "" when the file doesn't exist and null when it exists but couldn't
 * be decrypted, so a prune never mistakes a failed read for an empty file.
 */
const decryptEnvFile = async (
  directory: string,
  environment: Environment
): Promise<string | null> => {
  const envPath = path.join(
    getEnvDir(),
    directory,
    `${getEnvFileName(environment)}.enc`
  );

  if (!(await FileOperations.fileExists(envPath))) {
    output.info(`  No ${directory} environment file`);

    return "";
  }

  try {
    const content = await SopsService.decrypt(envPath);
    output.success(`  Decrypted ${directory} environment`);

    return content;
  } catch (error) {
    output.warning(
      `  Failed to decrypt ${directory} environment\n${error instanceof Error ? error.message : UNKNOWN_ERROR}`
    );

    return null;
  }
};

/**
 * What a sync pushes to one app: shared variables whose `# @apps:` scope
 * includes it, plus the app's own file, which wins on conflict.
 */
export const buildAppVariables = ({
  appContent,
  appName,
  sharedContent,
}: {
  /** Decrypted contents of the app's own env file ("" when it has none). */
  appContent: string;
  /** App name matched against `# @apps:` scopes. */
  appName: string;
  /** Decrypted contents of the shared env file ("" when there is none). */
  sharedContent: string;
}): EnvVariable[] => {
  const sharedVars = sharedContent
    ? EnvFilterService.filterForApp(sharedContent, appName)
    : [];

  const appVars = appContent
    ? EnvFilterService.filterForApp(appContent, appName)
    : [];

  const mergedVars = EnvMergeService.merge(sharedVars, appVars);

  // Annotations can live in either file — app-specific wins on conflict,
  // matching EnvMergeService's own value-merge precedence above.
  const typeAnnotations = new Map([
    ...parseSSMTypeAnnotations(sharedContent, appName),
    ...parseSSMTypeAnnotations(appContent),
  ]);

  return mergedVars.map((variable) => ({
    ...variable,
    type: typeAnnotations.get(variable.key),
  }));
};

const isOwnedOutsideFiles = (variable: VercelExistingVariable): boolean =>
  variable.isManaged ||
  Boolean(variable.gitBranch) ||
  variable.key.startsWith(VERCEL_SYSTEM_PREFIX) ||
  isExternallyManagedKey(variable.key);

export const findPruneCandidates = ({
  existing,
  expectedKeys,
}: {
  /** The project's variables in this environment, as Vercel lists them. */
  existing: VercelExistingVariable[];
  /** Keys the encrypted files define for this app. */
  expectedKeys: ReadonlySet<string>;
}): VercelExistingVariable[] =>
  existing.filter(
    (variable) =>
      !(expectedKeys.has(variable.key) || isOwnedOutsideFiles(variable))
  );

const describeRemoval = (variable: VercelExistingVariable): string => {
  const others =
    variable.targets.length + variable.customEnvironmentIds.length - 1;

  return others > 0
    ? `${variable.key} (narrowed; stays on ${others} other environment(s))`
    : variable.key;
};

export interface PruneAppEnvironmentDependencies {
  /** Inquirer's confirm prompt, asked once per project and environment. */
  confirm: typeof defaultConfirm;
}

/**
 * Lists, and with `shouldApply` removes after a confirm, the variables in one
 * project/environment that the encrypted files don't define for that app.
 * Removal only ever takes a variable out of this environment.
 */
export const createPruneAppEnvironment =
  ({ confirm }: PruneAppEnvironmentDependencies) =>
  async ({
    environment,
    expectedKeys,
    label,
    shouldApply,
    vercelService,
  }: {
    /** Environment whose variables are listed and pruned. */
    environment: Environment;
    /** Keys the encrypted files define for this app. */
    expectedKeys: ReadonlySet<string>;
    /** `app/environment`, prefixed to every line of output. */
    label: string;
    /** Remove after a confirm; otherwise only report. */
    shouldApply: boolean;
    /** Vercel client already initialized for this app's project. */
    vercelService: Pick<
      VercelService,
      "getEnvironmentVariables" | "removeFromEnvironment"
    >;
  }): Promise<number> => {
    const existing = await vercelService.getEnvironmentVariables(environment);
    const candidates = findPruneCandidates({ existing, expectedKeys });

    if (candidates.length === 0) {
      output.info(`  ${label}: nothing to prune`);

      return 0;
    }

    for (const variable of candidates) {
      output.warning(`  ${label}: would remove ${describeRemoval(variable)}`);
    }

    if (!shouldApply) {
      return 0;
    }

    const proceed = await confirm({
      default: false,
      message: `Remove ${candidates.length} variable(s) from ${label}?`,
    });

    if (!proceed) {
      output.info(`  ${label}: prune skipped`);

      return 0;
    }

    // sequential to avoid Vercel API rate limits
    await mapSequentially(candidates, async (variable) => {
      const outcome = await vercelService.removeFromEnvironment(
        variable,
        environment
      );

      output.success(`  ${label}: ${outcome} ${variable.key}`);
    });

    return candidates.length;
  };

export const pruneAppEnvironment = createPruneAppEnvironment({
  confirm: defaultConfirm,
});

const reportAppResults = (result: VercelSyncResult, dryRun: boolean): void => {
  if (result.added > 0) {
    output.success(
      `  ${dryRun ? "Would add" : "Added"} ${result.added} variable(s)`
    );
    output.log(`    Variables: ${result.addedKeys.join(", ")}`);
  }

  if (result.updated > 0) {
    output.success(
      `  ${dryRun ? "Would update" : "Updated"} ${result.updated} variable(s)`
    );
    output.log(`    Variables: ${result.updatedKeys.join(", ")}`);
  }

  if (result.skipped > 0) {
    output.info(`  Skipped ${result.skipped} unchanged variable(s)`);
    output.log(`    Variables: ${result.skippedKeys.join(", ")}`);
  }

  if (result.failed.length > 0) {
    output.error(`  Failed ${result.failed.length} variable(s):`);

    for (const key of result.failed) {
      output.log(`    - ${key}`);
    }
  }
};

const processApp = async ({
  app,
  environment,
  options,
  sharedContent,
}: {
  /** Vercel-linked app to sync. */
  app: AppConfig;
  /** Environment being synced. */
  environment: Environment;
  /** Dry-run and prune settings for the whole run. */
  options: SyncOptions;
  /** Decrypted shared env file; null when it failed to decrypt. */
  sharedContent: string | null;
}): Promise<AppResult> => {
  output.info(`\nProcessing ${app.name}...`);

  const project = await VercelService.resolveProject(app);

  if (!project) {
    output.warning(
      "  Skipped: Not linked to Vercel (no .vercel directory or VERCEL_PROJECT_ID in app.config)"
    );

    return EMPTY_APP_RESULT;
  }

  const appContent = await decryptEnvFile(app.name, environment);

  // An app from another repository only runs where it has its own file
  // (for example staging and production only); shared variables alone mustn't
  // populate its other Vercel environments.
  if (app.externalRepository && appContent === "") {
    output.info(`  Skipped: no ${environment} file for this app`);

    return EMPTY_APP_RESULT;
  }

  const typedVars = buildAppVariables({
    appContent: appContent ?? "",
    appName: app.name,
    sharedContent: sharedContent ?? "",
  });

  if (typedVars.length === 0) {
    output.warning("  No variables to sync");

    return EMPTY_APP_RESULT;
  }

  output.info(`  Prepared ${typedVars.length} variable(s) for sync`);

  const vercelService = await VercelService.create();
  vercelService.useProject(project);

  const result = await vercelService.syncEnvironmentVariables(
    typedVars,
    environment,
    options.dryRun
  );

  reportAppResults(result, options.dryRun);

  const appResult: AppResult = {
    added: result.added,
    failed: result.failed.length,
    pruned: 0,
    skipped: result.skipped,
    updated: result.updated,
  };

  if (options.prune === "off") {
    return appResult;
  }

  if (sharedContent === null || appContent === null) {
    output.error(
      "  Prune skipped: an encrypted file failed to decrypt, so the expected set is incomplete"
    );

    return { ...appResult, failed: appResult.failed + 1 };
  }

  appResult.pruned = await pruneAppEnvironment({
    environment,
    expectedKeys: new Set(typedVars.map((variable) => variable.key)),
    label: `${app.name}/${environment}`,
    shouldApply: options.prune === "apply" && !options.dryRun,
    vercelService,
  });

  return appResult;
};

const reportSyncSummary = (
  result: SyncResult,
  options: SyncOptions
): boolean => {
  const { dryRun } = options;
  output.log("");
  output.section("Sync Summary");

  if (dryRun) {
    output.info("DRY RUN - No changes were made\n");
  }

  output.log(`${dryRun ? "Would add" : "Added"}: ${result.totalAdded}`);
  output.log(`${dryRun ? "Would update" : "Updated"}: ${result.totalUpdated}`);
  output.log(`Skipped (unchanged): ${result.totalSkipped}`);

  if (options.prune === "apply" && !dryRun) {
    output.log(`Pruned: ${result.totalPruned}`);
  }

  if (result.totalFailed > 0) {
    output.error(`Failed: ${result.totalFailed}`);
  }

  if (result.errorCount > 0) {
    output.error(`Apps with errors: ${result.errorCount}`);
  }

  output.log("");

  const hasErrors = result.totalFailed > 0 || result.errorCount > 0;
  output.success(
    hasErrors ? "Sync completed with errors" : "Sync completed successfully"
  );

  return hasErrors;
};

const executeSyncForAllApps = async ({
  apps,
  environment,
  options,
  sharedContent,
}: {
  /** Every Vercel-linked app. */
  apps: AppConfig[];
  /** Environment being synced. */
  environment: Environment;
  /** Dry-run and prune settings for the whole run. */
  options: SyncOptions;
  /** Decrypted shared env file; null when it failed to decrypt. */
  sharedContent: string | null;
}): Promise<SyncResult> => {
  const syncResult: SyncResult = {
    errorCount: 0,
    totalAdded: 0,
    totalFailed: 0,
    totalPruned: 0,
    totalSkipped: 0,
    totalUpdated: 0,
  };

  // sequential to avoid Vercel API rate limits during bulk sync
  await mapSequentially(apps, async (app) => {
    try {
      const appResult = await processApp({
        app,
        environment,
        options,
        sharedContent,
      });

      syncResult.totalAdded += appResult.added;
      syncResult.totalUpdated += appResult.updated;
      syncResult.totalSkipped += appResult.skipped;
      syncResult.totalFailed += appResult.failed;
      syncResult.totalPruned += appResult.pruned;
    } catch (error) {
      if (isExitPromptError(error)) {
        throw error;
      }

      if (error instanceof VercelError) {
        output.error(`  ${error.message}`);
      } else {
        output.error(
          `  Failed: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`
        );
      }

      syncResult.errorCount += 1;
    }
  });

  return syncResult;
};

const resolvePruneMode = (options: {
  /** Set by `--prune`: report only. */
  prune?: boolean;
  /** Set by `--confirm-prune`: report and remove after a confirm. */
  confirmPrune?: boolean;
}): PruneMode => {
  if (options.confirmPrune) {
    return "apply";
  }

  return options.prune ? "report" : "off";
};

/**
 * Runs the Vercel sync and returns whether it failed, rather than exiting the
 * process directly — callable from the `add` wizard (which still has more
 * work to do afterward), not just the CLI action below.
 */
export const handleSyncCommand = async (
  environmentArg: string,
  options: {
    /** Report the Vercel env changes without applying them; defaults off. */
    dryRun?: boolean;
    /** Sets `process.env.DEBUG` so value comparisons are logged. */
    debug?: boolean;
    /** Also list variables the encrypted files don't define for that app. */
    prune?: boolean;
    /** Remove what `prune` lists, after a confirm per project and environment. */
    confirmPrune?: boolean;
  }
): Promise<boolean> => {
  const syncOptions: SyncOptions = {
    dryRun: options.dryRun ?? false,
    prune: resolvePruneMode(options),
  };

  if (options.debug) {
    process.env.DEBUG = "true";
    output.info("Debug mode enabled\n");
  }

  const environments = await validateEnvironmentAndSetup(
    environmentArg,
    syncOptions.dryRun
  );

  const apps = await AppDiscoveryService.getVercelApps();

  if (apps.length === 0) {
    output.warning("No Vercel apps found");

    return false;
  }

  // sequential per environment so console output stays readable and ordered
  const environmentErrors = await mapSequentially(
    environments,
    async (environment) => {
      output.section(`Syncing to Vercel: ${environment}`);

      output.info("\nDecrypting shared environment...");
      const sharedContent = await decryptEnvFile("shared", environment);

      const syncResult = await executeSyncForAllApps({
        apps,
        environment,
        options: syncOptions,
        sharedContent,
      });

      return reportSyncSummary(syncResult, syncOptions);
    }
  );

  return environmentErrors.includes(true);
};

export const syncVercelCommand = new Command("sync")
  .description("Sync environment variables to Vercel")
  .argument(
    "[environment]",
    "Environment to sync (production, staging, preview, development, all)",
    "all"
  )
  .option("--dry-run", "Show what would be synced without making changes")
  .option("--debug", "Enable debug logging to see value comparisons")
  .option(
    "--prune",
    "Also list Vercel variables the encrypted files don't define for that app (report only)"
  )
  .option(
    "--confirm-prune",
    "Remove what --prune lists from that environment, after a confirm prompt per project and environment"
  )
  .action(
    async (
      environmentArg: string,
      options: {
        /** Set by `--dry-run`: show the Vercel changes without making them. */
        dryRun?: boolean;
        /** Set by `--debug`: log why each variable is or isn't updated. */
        debug?: boolean;
        /** Set by `--prune`: list variables the files don't define. */
        prune?: boolean;
        /** Set by `--confirm-prune`: remove them after a confirm. */
        confirmPrune?: boolean;
      }
    ) => {
      try {
        const failed = await handleSyncCommand(environmentArg, options);
        process.exit(failed ? 1 : 0);
      } catch (error) {
        if (isExitPromptError(error)) {
          output.info("\nCancelled.");
          process.exit(0);
        }

        if (error instanceof AWSCredentialsError) {
          outputAWSCredentialsError(error);
        } else {
          output.error(error instanceof Error ? error.message : "Sync failed");
        }

        process.exit(1);
      }
    }
  );
