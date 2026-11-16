import path from "node:path";

import { search } from "@inquirer/prompts";

import { getEnvDir } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { EnvMergeService } from "../services/env-merge.service";
import { SopsService } from "../services/sops.service";
import type { Environment } from "../types/app-config.types";
import { getEnvFileName } from "./env-parser";
import { FileOperations } from "./file-operations";

export const SHARED_DIR_NAME = "shared";

/** One file that currently defines the variable. */
export interface KeyLocation {
  /** Folder under env/: `shared` or an app name. */
  directory: string;
  /** Environment whose `.env.<environment>.enc` in that folder has the key. */
  environment: Environment;
}

/**
 * Where a variable may be defined: `shared/` plus one directory per app. An
 * app-scoped definition overrides the shared one (EnvMergeService.merge), so
 * acting on `shared/` alone while an app copy exists would leave the old
 * definition winning — every location has to be found, not just the first.
 */
export const envDirectoryNames = async (): Promise<string[]> => {
  const apps = await AppDiscoveryService.getAllApps();

  return [SHARED_DIR_NAME, ...apps.map((app) => app.name)];
};

/**
 * Every variable defined across the chosen environments, and which files
 * define it. Read once up front so a picker can offer what actually exists
 * rather than having the user guess a name and find out afterwards.
 */
export const collectKeyLocations = async (
  environments: Environment[]
): Promise<Map<string, KeyLocation[]>> => {
  const directories = await envDirectoryNames();
  const locations = new Map<string, KeyLocation[]>();

  const candidates = environments.flatMap((environment) =>
    directories.map((directory) => ({ directory, environment }))
  );

  // each decrypt is a sops subprocess; running them all at once floods KMS and scrambles output
  await mapSequentially(candidates, async ({ directory, environment }) => {
    const encPath = path.join(
      getEnvDir(),
      directory,
      `${getEnvFileName(environment)}.enc`
    );

    if (!(await FileOperations.fileExists(encPath))) {
      return;
    }

    const content = await SopsService.decrypt(encPath);

    for (const key of EnvMergeService.extractKeys(content)) {
      const existing = locations.get(key) ?? [];
      existing.push({ directory, environment });
      locations.set(key, existing);
    }
  });

  return locations;
};

/** "shared, web" — where the variable lives, shown beside each choice. */
export const describeLocations = (locations: KeyLocation[]): string => {
  const directories = [
    ...new Set(locations.map((location) => location.directory)),
  ];

  return directories.join(", ");
};

/**
 * Picks from what the chosen environments actually define, narrowing as you
 * type. Offering a free-text name instead would let you spell a variable that
 * isn't there and only find out after the files have been decrypted.
 */
export const promptForKey = async ({
  locations,
  message,
}: {
  /** From `collectKeyLocations`: each defined key and the files that define it. */
  locations: Map<string, KeyLocation[]>;
  /** Prompt text; the key count and a "type to narrow" hint are appended. */
  message: string;
}): Promise<string> => {
  const keys = [...locations.keys()].toSorted();

  return await search<string>({
    message: `${message} (${keys.length} defined, type to narrow)`,
    source: (term) => {
      const needle = term?.trim().toUpperCase() ?? "";

      return keys.flatMap((key) =>
        key.includes(needle)
          ? [
              {
                description: `defined in ${describeLocations(locations.get(key) ?? [])}`,
                name: key,
                value: key,
              },
            ]
          : []
      );
    },
  });
};
