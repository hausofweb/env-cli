import path from "node:path";

import { Command } from "commander";

import { ENVIRONMENTS } from "../constants/environments";
import { getEnvDir } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { SopsService } from "../services/sops.service";
import type { Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import { getEnvFileName } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";

/** Running tally mutated in place across every app/environment `env encrypt` visits. */
interface EncryptionStats {
  /** Plaintext files SOPS wrote a `.enc` for. */
  encryptedCount: number;
  /** Files where `sops --encrypt` threw. */
  errorCount: number;
  /** Files with no plaintext on disk or that were already SOPS-encrypted. */
  skippedCount: number;
}

const processEnvironmentFile = async (
  appEnvDir: string,
  env: Environment,
  stats: EncryptionStats
): Promise<void> => {
  const inputFile = path.join(appEnvDir, getEnvFileName(env));
  const outputFile = path.join(appEnvDir, `${getEnvFileName(env)}.enc`);

  output.debug(`  Checking ${inputFile}`);

  const shouldSkip = !(await FileOperations.fileExists(inputFile));

  if (shouldSkip) {
    output.debug("    File does not exist, skipping");
    output.log(`  Skipped ${env} (decrypted file not found)`);
    stats.skippedCount += 1;

    return;
  }

  output.debug("    File exists, checking if already encrypted");

  const isAlreadyEncrypted = await SopsService.isEncrypted(inputFile);

  if (isAlreadyEncrypted) {
    output.debug("    File is already encrypted, skipping");
    output.log(`  Skipped ${env} (already encrypted)`);
    stats.skippedCount += 1;

    return;
  }

  output.debug("    File is unencrypted, proceeding with encryption");
  output.debug(`    Input: ${inputFile}`);
  output.debug(`    Output: ${outputFile}`);

  try {
    await SopsService.encrypt(inputFile, outputFile);
    output.success(`  Encrypted ${env}`);
    stats.encryptedCount += 1;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    output.debug(`    Encryption error details: ${errorMessage}`);
    output.error(`  Failed to encrypt ${env}: ${errorMessage}`);
    stats.errorCount += 1;
  }
};

const processApp = async (
  app: {
    /** Folder under `env/` whose plaintext files get encrypted. */
    name: string;
  },
  stats: EncryptionStats
): Promise<void> => {
  output.info(`\nProcessing ${app.name}...`);
  const appEnvDir = path.join(getEnvDir(), app.name);

  // sequential so per-env console output stays readable and ordered
  await mapSequentially(ENVIRONMENTS, (env) =>
    processEnvironmentFile(appEnvDir, env, stats)
  );
};

const runEncryption = async (): Promise<void> => {
  SopsService.validateSopsInstalled();

  const apps = await AppDiscoveryService.getAllApps();
  const sharedEnvDir = path.join(getEnvDir(), "shared");
  const hasSharedEnv = await FileOperations.dirExists(sharedEnvDir);

  if (apps.length === 0 && !hasSharedEnv) {
    output.warning("No apps found or shared env found");
    process.exit(0);
  }

  await checkAndAuthenticateAWS();

  output.section("Encrypting Environment Files");

  const stats: EncryptionStats = {
    encryptedCount: 0,
    errorCount: 0,
    skippedCount: 0,
  };

  // Process shared environment first
  if (hasSharedEnv) {
    output.info("\nProcessing shared...");
    // sequential so per-env console output stays readable and ordered
    await mapSequentially(ENVIRONMENTS, (env) =>
      processEnvironmentFile(sharedEnvDir, env, stats)
    );
  } else {
    output.debug("Shared env directory not found, skipping");
  }

  // sequential so per-app console output stays readable and ordered
  await mapSequentially(apps, (app) => processApp(app, stats));

  output.log("");
  output.success(
    `Encryption complete: ${stats.encryptedCount} encrypted, ${stats.skippedCount} skipped`
  );

  if (stats.errorCount > 0) {
    output.warning(`${stats.errorCount} error(s) occurred`);
  }

  process.exit(stats.errorCount > 0 ? 1 : 0);
};

export const encryptCommand = new Command("encrypt")
  .description("Encrypt all environment files with SOPS")
  .action(async () => {
    try {
      await runEncryption();
    } catch (error) {
      if (error instanceof AWSCredentialsError) {
        outputAWSCredentialsError(error);
      } else {
        output.error(
          error instanceof Error ? error.message : "Encryption failed"
        );
      }

      process.exit(1);
    }
  });
