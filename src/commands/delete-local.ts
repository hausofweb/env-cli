import path from "node:path";

import { Command } from "commander";

import { getProjectRoot } from "../constants/paths";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { output } from "../utils/cli-output";
import { FileOperations } from "../utils/file-operations";

export const deleteLocalCommand = new Command("delete-local")
  .description("Delete all .env.local files")
  .action(async () => {
    try {
      const apps = await AppDiscoveryService.getAllApps();

      if (apps.length === 0) {
        output.warning("No apps found");
        process.exit(0);
      }

      output.info("Deleting .env.local files...\n");

      const results = await Promise.all(
        apps.map(async (app) => {
          if (!app.directory) {
            return "notFound" as const;
          }

          const appDir = path.join(getProjectRoot(), app.directory);
          const envLocalPath = path.join(appDir, ".env.local");

          if (await FileOperations.fileExists(envLocalPath)) {
            await FileOperations.removeFile(envLocalPath);
            output.success(`Deleted ${app.name}/.env.local`);

            return "deleted" as const;
          }

          output.log(`  Skipped ${app.name}/.env.local (not found)`);

          return "notFound" as const;
        })
      );

      const deletedCount = results.filter((r) => r === "deleted").length;
      const notFoundCount = results.filter((r) => r === "notFound").length;

      output.log("");
      output.success(`Deleted ${deletedCount} file(s)`);

      if (notFoundCount > 0) {
        output.info(`${notFoundCount} file(s) not found`);
      }

      process.exit(0);
    } catch (error) {
      output.error(
        error instanceof Error ? error.message : "Failed to delete files"
      );
      process.exit(1);
    }
  });
