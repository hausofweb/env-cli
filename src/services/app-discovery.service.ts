import path from "node:path";

import { IGNORE_DIRS, IGNORE_PATTERNS } from "../constants/ignore-patterns";
import {
  APP_CONFIG_FILENAME,
  defaultAppDirectory,
  getEnvDir,
} from "../constants/paths";
import type {
  AppConfig,
  AppConfigFile,
  AppType,
} from "../types/app-config.types";
import { AppNotFoundError } from "../types/app-not-found-error";
import { envVariablePattern } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";

const APP_CONFIG_KEYS: readonly string[] = [
  "APP_DIRECTORY",
  "APP_TYPE",
  "EXTERNAL_REPOSITORY",
  "VERCEL_PROJECT",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
] satisfies (keyof AppConfigFile)[];

const isAppConfigKey = (key: string): key is keyof AppConfigFile =>
  APP_CONFIG_KEYS.includes(key);

/**
 * Service for discovering and managing app configurations
 */
export const AppDiscoveryService = {
  /**
   * Get all apps from env/ directory
   */
  getAllApps: async (): Promise<AppConfig[]> => {
    if (!(await FileOperations.dirExists(getEnvDir()))) {
      return [];
    }

    const entries = await FileOperations.listDir(getEnvDir());

    const candidates = await Promise.all(
      entries.map(async (entry) => {
        // Skip if should be ignored
        if (AppDiscoveryService.shouldIgnoreDirectory(entry)) {
          return null;
        }

        // Skip files - only process directories
        const entryPath = path.join(getEnvDir(), entry);

        if (!(await FileOperations.dirExists(entryPath))) {
          return null;
        }

        try {
          return await AppDiscoveryService.getAppConfig(entry);
        } catch (error) {
          console.warn(`Skipping invalid app directory: ${entry}\n${error}`);

          return null;
        }
      })
    );

    const apps = candidates.filter((app): app is AppConfig => app !== null);

    return apps.toSorted((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Get configuration for a specific app
   */
  getAppConfig: async (appName: string): Promise<AppConfig> => {
    const configPath = path.join(getEnvDir(), appName, APP_CONFIG_FILENAME);

    const config: AppConfig = {
      directory: defaultAppDirectory(appName),
      name: appName,
      type: "vercel",
    };

    // Try to read app.config file
    if (await FileOperations.fileExists(configPath)) {
      try {
        const content = await FileOperations.readFile(configPath);
        const parsed = AppDiscoveryService.parseAppConfig(content);

        if (parsed.APP_TYPE) {
          // SAFETY: app.config files are checked in under env and
          // every APP_TYPE there is one of AppType's literals.
          config.type = parsed.APP_TYPE as AppType;
        }

        if (parsed.APP_DIRECTORY) {
          config.directory = parsed.APP_DIRECTORY;
        }

        if (parsed.VERCEL_PROJECT) {
          config.vercelProject = parsed.VERCEL_PROJECT;
        }

        if (parsed.EXTERNAL_REPOSITORY) {
          config.externalRepository = parsed.EXTERNAL_REPOSITORY;
          delete config.directory;
        }

        config.vercelProjectId = parsed.VERCEL_PROJECT_ID;
        config.vercelTeamId = parsed.VERCEL_TEAM_ID;
      } catch (error) {
        // Use defaults if config file is invalid
        console.warn(`Failed to read app config for ${appName}\n${error}`);
      }
    }

    return config;
  },

  /**
   * Get non-Vercel apps only
   */
  getNonVercelApps: async (): Promise<AppConfig[]> => {
    const allApps = await AppDiscoveryService.getAllApps();

    return allApps.filter((app) => app.type !== "vercel");
  },

  /**
   * Get Vercel apps only
   */
  getVercelApps: async (): Promise<AppConfig[]> => {
    const allApps = await AppDiscoveryService.getAllApps();

    return allApps.filter((app) => app.type === "vercel");
  },

  /**
   * Check if app exists
   */
  isValidApp: async (appName: string): Promise<boolean> => {
    const allApps = await AppDiscoveryService.getAllApps();

    return allApps.some((app) => app.name === appName);
  },

  /**
   * Parse app.config file content
   */
  parseAppConfig: (content: string): AppConfigFile => {
    const config: AppConfigFile = {};
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Parse KEY=VALUE
      const match = envVariablePattern.exec(trimmed);
      const key = match?.groups?.key;

      if (match && key && isAppConfigKey(key)) {
        config[key] = match[3] || match[4] || match[5];
      }
    }

    return config;
  },

  /**
   * Check if directory should be ignored
   */
  shouldIgnoreDirectory: (dirName: string): boolean => {
    // Check ignore list
    if (IGNORE_DIRS.includes(dirName)) {
      return true;
    }

    // Check regex patterns
    for (const pattern of IGNORE_PATTERNS) {
      if (pattern.test(dirName)) {
        return true;
      }
    }

    return false;
  },

  /**
   * Validate app name and throw if invalid
   */
  validateApp: async (appName: string): Promise<void> => {
    if (!(await AppDiscoveryService.isValidApp(appName))) {
      const allApps = await AppDiscoveryService.getAllApps();
      throw new AppNotFoundError(
        appName,
        allApps.map((app) => app.name)
      );
    }
  },
};
