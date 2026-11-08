import path from "node:path";
import { createInterface } from "node:readline/promises";

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
import type { Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import { getEnvFileName } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";

/** App configs discovered under `env/`, one per app directory. */
type AppConfigs = Awaited<ReturnType<typeof AppDiscoveryService.getAllApps>>;

const promptEnvironment = async (): Promise<Environment> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const defaultEnvironment: Environment = "development";
  const defaultIndex = ENVIRONMENTS.indexOf(defaultEnvironment) + 1;

  output.log("\nAvailable environments:");

  for (const [index, env] of ENVIRONMENTS.entries()) {
    output.log(`  ${index + 1}. ${env}`);
  }

  const answer = await rl.question(
    `\nSelect environment (1-${ENVIRONMENTS.length}) [default: ${defaultIndex} (${defaultEnvironment})]: `
  );

  rl.close();

  const choice = Number(answer.trim() || String(defaultIndex));

  if (!Number.isInteger(choice) || choice < 1 || choice > ENVIRONMENTS.length) {
    output.warning(`Invalid choice, using ${defaultEnvironment}`);

    return defaultEnvironment;
  }

  return ENVIRONMENTS[choice - 1];
};

const selectAppsInteractively = async (
  allApps: AppConfigs
): Promise<AppConfigs> => {
  output.log("\nAvailable apps:");

  for (const [index, app] of allApps.entries()) {
    output.log(`  ${index + 1}. ${app.name}`);
  }

  output.log(`  ${allApps.length + 1}. all`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await rl.question("\nSelect app: ");
  rl.close();

  const choice = Number(answer.trim());

  if (choice === allApps.length + 1) {
    return allApps;
  }

  if (Number.isInteger(choice) && choice >= 1 && choice <= allApps.length) {
    return [allApps[choice - 1]];
  }

  output.error("Invalid choice");
  process.exit(1);
};

const getAppsToSetup = async (appArg?: string): Promise<AppConfigs> => {
  if (!appArg) {
    const allApps = await AppDiscoveryService.getAllApps();

    if (allApps.length === 0) {
      output.warning("No apps found");
      process.exit(0);
    }

    return selectAppsInteractively(allApps);
  }

  if (appArg.toLowerCase() === "all") {
    return AppDiscoveryService.getAllApps();
  }

  await AppDiscoveryService.validateApp(appArg);
  const appConfig = await AppDiscoveryService.getAppConfig(appArg);

  return [appConfig];
};

const decryptEnvironment = async (
  envPath: string,
  label: string
): Promise<string> => {
  if (!(await FileOperations.fileExists(envPath))) {
    return "";
  }

  try {
    const content = await SopsService.decrypt(envPath);
    output.success(`  Decrypted ${label}`);

    return content;
  } catch (error) {
    output.warning(
      `  Failed to decrypt ${label}\n${error instanceof Error ? error.message : "Unknown error"}`
    );

    return "";
  }
};

const setupApp = async (
  appName: string,
  environment: Environment
): Promise<void> => {
  output.info(`\nSetting up ${appName} for ${environment}...`);

  const app = await AppDiscoveryService.getAppConfig(appName);
  const appEnvDir = path.join(getEnvDir(), app.name);

  const sharedEnvPath = path.join(
    getEnvDir(),
    "shared",
    `${getEnvFileName(environment)}.enc`
  );

  const appEnvPath = path.join(appEnvDir, `${getEnvFileName(environment)}.enc`);

  // One sops run at a time: concurrent decrypts flood KMS and interleave output.
  const [sharedContent, appContent] = await mapSequentially(
    [
      { envPath: sharedEnvPath, label: "shared environment" },
      { envPath: appEnvPath, label: "app environment" },
    ],
    ({ envPath, label }) => decryptEnvironment(envPath, label)
  );

  // Write decrypted app-specific content directly to env/{app}/ directory
  const envFileName = getEnvFileName(environment);
  const envFilePath = path.join(appEnvDir, envFileName);

  if (appContent.trim() || appContent === "") {
    await FileOperations.writeFile(envFilePath, appContent);

    const appVarCount = EnvFilterService.filterForApp(
      appContent,
      app.name
    ).length;

    output.success(
      `  Wrote ${envFileName} to env/${app.name}/ (${appVarCount} variables)`
    );
  } else {
    output.info(`  No app-specific variables for ${environment}`);
  }

  if (!app.directory) {
    output.info("  No app directory in this repo; no .env.local to write");

    return;
  }

  // Only copy development environment to app directory as .env.local
  if (environment === "development") {
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

      return;
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
  } else {
    output.info(`  Skipped copy to app directory (${environment} environment)`);
  }
};

const setupApps = async (
  apps: AppConfigs,
  environment: Environment
): Promise<{ successCount: number; errorCount: number }> => {
  // sequential so per-app console output stays readable and ordered
  const results = await mapSequentially(apps, async (app) => {
    try {
      await setupApp(app.name, environment);

      return true;
    } catch (error) {
      output.error(
        `Failed to setup ${app.name}: ${error instanceof Error ? error.message : "Unknown error"}`
      );

      return false;
    }
  });

  const successCount = results.filter(Boolean).length;

  return { errorCount: results.length - successCount, successCount };
};

export const setupLocalCommand = new Command("setup")
  .description("Setup local development environment for an app")
  .argument("[app]", 'App name to setup (or "all" for all apps)')
  .action(async (appArg?: string) => {
    try {
      await checkAndAuthenticateAWS();

      SopsService.validateSopsInstalled();
      output.section("Local Development Setup");

      const environment = await promptEnvironment();
      const apps = await getAppsToSetup(appArg);
      const { successCount, errorCount } = await setupApps(apps, environment);

      output.log("");
      output.success(
        `Setup complete: ${successCount} successful, ${errorCount} failed`
      );

      process.exit(errorCount > 0 ? 1 : 0);
    } catch (error) {
      if (error instanceof AWSCredentialsError) {
        outputAWSCredentialsError(error);
      } else {
        output.error(error instanceof Error ? error.message : "Setup failed");
      }

      process.exit(1);
    }
  });
