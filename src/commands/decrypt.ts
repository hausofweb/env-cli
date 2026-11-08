import path from "node:path";

import { Command } from "commander";

import { ENVIRONMENTS } from "../constants/environments";
import { getEnvDir, getProjectRoot } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { EnvFilterService } from "../services/env-filter.service";
import { EnvMergeService } from "../services/env-merge.service";
import { SopsService } from "../services/sops.service";
import type { AppConfig, Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import { getEnvFileName } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";

const UNKNOWN_ERROR = "Unknown error";

const validateEnvironment = (environment: string): Environment => {
  const match = ENVIRONMENTS.find((candidate) => candidate === environment);

  if (!match) {
    throw new Error(
      `Invalid environment: ${environment}. Must be one of: ${ENVIRONMENTS.join(", ")}, all`
    );
  }

  return match;
};

export const resolveDecryptEnvironments = (
  environmentArg: string
): Environment[] =>
  environmentArg === "all"
    ? ENVIRONMENTS
    : [validateEnvironment(environmentArg)];

const decryptEnvironmentFile = async (
  filePath: string,
  description: string
): Promise<{ content: string; wasDecrypted: boolean }> => {
  if (!(await FileOperations.fileExists(filePath))) {
    output.warning(`  No ${description} file found`);

    return { content: "", wasDecrypted: false };
  }

  try {
    const content = await SopsService.decrypt(filePath);
    output.success(`  Decrypted ${description}`);

    return { content, wasDecrypted: true };
  } catch (error) {
    output.debug(
      `  Failed to decrypt: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`
    );
    throw error;
  }
};

const processApp = async (
  app: {
    /** Folder under `env/` and the `@apps:` name shared lines filter on. */
    name: string;
    /** Repo-relative app root that receives `.env.local` for development; undefined for an app outside this repo. */
    directory?: string;
  },
  environment: Environment,
  sharedContent: string,
  shouldCopy: boolean
): Promise<{ success: boolean; error?: string }> => {
  try {
    const appEnvDir = path.join(getEnvDir(), app.name);

    const appEnvPath = path.join(
      appEnvDir,
      `${getEnvFileName(environment)}.enc`
    );

    output.info(`\nProcessing ${app.name}...`);

    const { content: appContent, wasDecrypted } = await decryptEnvironmentFile(
      appEnvPath,
      "app environment"
    );

    // Write decrypted app-specific content directly to env/{app}/ directory
    const envFileName = getEnvFileName(environment);
    const envFilePath = path.join(appEnvDir, envFileName);

    if (wasDecrypted) {
      await FileOperations.writeFile(envFilePath, appContent);

      const appVarCount = EnvFilterService.filterForApp(
        appContent,
        app.name
      ).length;

      output.success(
        `  Wrote ${envFileName} to env/${app.name}/ (${appVarCount} variables)`
      );
    } else {
      output.warning(
        `  Skipped writing ${envFileName} (decryption failed or file missing)`
      );
    }

    if (!app.directory) {
      output.info("  No app directory in this repo; no .env.local to write");

      return { success: true };
    }

    // Only copy development environment to app directory as .env.local
    if (shouldCopy && environment === "development") {
      // Filter shared content for this app
      const sharedFiltered = sharedContent
        ? EnvFilterService.filterForAppWithFormatting(sharedContent, app.name)
        : "";

      // Merge shared + app for copying to app directory
      const mergedContent = EnvMergeService.mergeFormatted(
        sharedFiltered,
        appContent
      );

      if (!mergedContent.trim()) {
        output.warning("  No variables to copy");

        return { success: true };
      }

      const totalVarCount = EnvFilterService.filterForApp(
        mergedContent,
        app.name
      ).length;

      output.info(`  Total merged: ${totalVarCount} variable(s)`);

      const appDir = path.join(getProjectRoot(), app.directory);
      const envLocalPath = path.join(appDir, ".env.local");
      await FileOperations.writeFile(envLocalPath, mergedContent);
      output.success(`  Copied to ${app.directory}/.env.local`);
    } else if (environment !== "development") {
      output.info(
        `  Skipped copy to app directory (${environment} environment)`
      );
    }

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : UNKNOWN_ERROR;
    output.error(`  Failed: ${errorMsg}`);

    return { error: errorMsg, success: false };
  }
};

/**
 * Decrypts one environment for the given apps, writing plaintext files under
 * env/ and (for development, when shouldCopy) each app's own
 * .env.local. Shared across the `decrypt` command and the `add` wizard, which
 * needs to refresh local plaintext after writing new variables.
 */
export const decryptEnvironment = async (
  environment: Environment,
  apps: AppConfig[],
  shouldCopy: boolean
): Promise<{ successCount: number; errorCount: number }> => {
  output.section(`Decrypting Environment: ${environment}`);

  output.info("\nDecrypting shared environment...");

  const sharedEnvPath = path.join(
    getEnvDir(),
    "shared",
    `${getEnvFileName(environment)}.enc`
  );

  let sharedContent = "";
  let sharedFailed = false;

  try {
    const result = await decryptEnvironmentFile(
      sharedEnvPath,
      "shared environment"
    );

    sharedContent = result.content;

    // Write decrypted shared content to env/shared/ directory
    if (result.wasDecrypted) {
      const sharedEnvDir = path.join(getEnvDir(), "shared");
      const envFileName = getEnvFileName(environment);
      const sharedEnvFilePath = path.join(sharedEnvDir, envFileName);
      await FileOperations.writeFile(sharedEnvFilePath, sharedContent);

      const sharedVarCount = sharedContent
        .split("\n")
        .filter((line) => line.trim() && !line.trim().startsWith("#")).length;

      output.success(
        `  Wrote ${envFileName} to env/shared/ (${sharedVarCount} variables)`
      );
    }
  } catch (error) {
    sharedFailed = true;
    output.error(
      `  Failed to decrypt shared environment for ${environment}: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`
    );
  }

  // sequential so per-app console output stays readable and ordered
  const results = await mapSequentially(apps, (app) =>
    processApp(app, environment, sharedContent, shouldCopy)
  );

  const successCount = results.filter((result) => result.success).length;
  const errorCount = (sharedFailed ? 1 : 0) + results.length - successCount;

  return { errorCount, successCount };
};

export const decryptCommand = new Command("decrypt")
  .description("Decrypt environment files and create .env.local files")
  .option(
    "--all",
    "No-op: every app, Vercel or not, is decrypted by default (kept so existing commands still parse)"
  )
  .option(
    "--no-copy",
    "Skip copying decrypted files to app directories (useful for dry-run)"
  )
  .argument(
    "[environment]",
    "Environment to decrypt (production, staging, preview, development, all)",
    "development"
  )
  .action(
    async (
      environmentArg: string,
      options: {
        /** False under `--no-copy`: skip writing each app's `.env.local`. */
        copy: boolean;
      }
    ) => {
      try {
        const environments = resolveDecryptEnvironments(environmentArg);

        await checkAndAuthenticateAWS();

        SopsService.validateSopsInstalled();

        const apps = await AppDiscoveryService.getAllApps();

        if (apps.length === 0) {
          output.warning("No apps found");
          process.exit(0);
        }

        // sequential per environment so console output stays readable and ordered
        const results = await mapSequentially(environments, (environment) =>
          decryptEnvironment(environment, apps, options.copy)
        );

        let totalSuccess = 0;
        let totalErrors = 0;

        for (const { successCount, errorCount } of results) {
          totalSuccess += successCount;
          totalErrors += errorCount;
        }

        output.log("");
        output.success(
          `Decryption complete: ${totalSuccess} successful, ${totalErrors} failed`
        );

        process.exit(totalErrors > 0 ? 1 : 0);
      } catch (error) {
        if (error instanceof AWSCredentialsError) {
          outputAWSCredentialsError(error);
        } else {
          output.error(
            error instanceof Error ? error.message : "Decryption failed"
          );
        }

        process.exit(1);
      }
    }
  );
