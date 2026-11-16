import { Command } from "commander";

import { AppDiscoveryService } from "../services/app-discovery.service";
import { output } from "../utils/cli-output";

export const listAppsCommand = new Command("list")
  .description("List all apps with their types")
  .action(async () => {
    try {
      const apps = await AppDiscoveryService.getAllApps();

      if (apps.length === 0) {
        output.warning("No apps found in env/ directory");
        process.exit(0);
      }

      output.section("Apps");

      const vercelApps = apps.filter((app) => app.type === "vercel");
      const nonVercelApps = apps.filter((app) => app.type !== "vercel");

      if (vercelApps.length > 0) {
        output.info("\nVercel Apps:");

        for (const app of vercelApps) {
          const projectInfo = app.vercelProject
            ? ` (${app.vercelProject})`
            : "";

          output.log(`  • ${app.name}${projectInfo}`);
        }
      }

      if (nonVercelApps.length > 0) {
        output.info("\nNon-Vercel Apps:");

        for (const app of nonVercelApps) {
          output.log(`  • ${app.name} [${app.type}]`);
        }
      }

      output.log(`\nTotal: ${apps.length} apps`);

      process.exit(0);
    } catch (error) {
      output.error(
        error instanceof Error ? error.message : "Failed to list apps"
      );
      process.exit(1);
    }
  });
