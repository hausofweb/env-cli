import type { EnvVariable } from "../types/env-file.types";
import { envVariablePattern, serializeEnvContent } from "../utils/env-parser";

/** Per-key comparison of a current variable set against the desired one. */
interface EnvDiff {
  /** Keys only in the desired set. */
  added: EnvVariable[];
  /** Keys in both whose value changed, carrying the desired value. */
  updated: EnvVariable[];
  /** Keys in both with the same value. */
  unchanged: EnvVariable[];
  /** Keys only in the current set, carrying the current value. */
  removed: EnvVariable[];
}

/**
 * Service for merging environment variables from multiple sources
 */
export const EnvMergeService = {
  /**
   * Compare two variable arrays and return differences
   */
  diff: (current: EnvVariable[], desired: EnvVariable[]): EnvDiff => {
    const currentMap = new Map(current.map((v) => [v.key, v.value]));
    const desiredMap = new Map(desired.map((v) => [v.key, v.value]));

    const added: EnvVariable[] = [];
    const updated: EnvVariable[] = [];
    const unchanged: EnvVariable[] = [];
    const removed: EnvVariable[] = [];

    // Check desired variables
    for (const [key, value] of desiredMap) {
      if (!currentMap.has(key)) {
        added.push({ key, value });
      } else if (currentMap.get(key) === value) {
        unchanged.push({ key, value });
      } else {
        updated.push({ key, value });
      }
    }

    // Check removed variables
    for (const [key, value] of currentMap) {
      if (!desiredMap.has(key)) {
        removed.push({ key, value });
      }
    }

    return { added, removed, unchanged, updated };
  },

  /**
   * Extract variable keys from env content
   */
  extractKeys: (content: string): Set<string> => {
    const keys = new Set<string>();
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      const match = envVariablePattern.exec(trimmed);

      if (match) {
        keys.add(match[1]);
      }
    }

    return keys;
  },

  /**
   * Filter out lines that have keys in the provided set
   */
  filterOverriddenKeys: (content: string, keysToSkip: Set<string>): string => {
    const lines = content.split("\n");
    const filteredLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Keep comments and empty lines
      const isComment = trimmed.startsWith("#");
      const isEmpty = !trimmed;

      if (isEmpty || isComment) {
        filteredLines.push(line);
        continue;
      }

      // Check if this variable will be overridden
      const match = envVariablePattern.exec(trimmed);

      if (match) {
        const [, key] = match;

        if (!keysToSkip.has(key)) {
          filteredLines.push(line);
        }
      } else {
        filteredLines.push(line);
      }
    }

    return filteredLines.join("\n");
  },
  /**
   * Merge shared and app-specific variables
   * App-specific variables override shared variables
   */
  merge: (sharedVars: EnvVariable[], appVars: EnvVariable[]): EnvVariable[] => {
    const merged = new Map<string, string>();

    // Add shared variables first
    for (const variable of sharedVars) {
      merged.set(variable.key, variable.value);
    }

    // App-specific variables override shared
    for (const variable of appVars) {
      merged.set(variable.key, variable.value);
    }

    // Convert back to array
    return [...merged.entries()].map(([key, value]) => ({
      key,
      value,
    }));
  },

  /**
   * Merge formatted env content strings, preserving comments and formatting
   * App-specific content overrides shared content for duplicate keys
   */
  mergeFormatted: (sharedContent: string, appContent: string): string => {
    if (!sharedContent) {
      return appContent || "";
    }

    if (!appContent) {
      return sharedContent;
    }

    // Get keys from app content to know what to skip from shared
    const appKeys = EnvMergeService.extractKeys(appContent);

    // Filter shared content to remove keys that will be overridden
    const filteredShared = EnvMergeService.filterOverriddenKeys(
      sharedContent,
      appKeys
    );

    // Combine: filtered shared content + separator + app content
    const trimmedShared = filteredShared.trim();
    const trimmedApp = appContent.trim();
    const separator = trimmedApp ? "\n\n" : "";

    return `${trimmedShared}${separator}${trimmedApp}`;
  },

  /**
   * Merge multiple variable arrays (later arrays override earlier ones)
   */
  mergeMultiple: (...varArrays: EnvVariable[][]): EnvVariable[] => {
    const merged = new Map<string, string>();

    for (const vars of varArrays) {
      for (const variable of vars) {
        merged.set(variable.key, variable.value);
      }
    }

    return [...merged.entries()].map(([key, value]) => ({
      key,
      value,
    }));
  },

  /**
   * Convert array of variables to .env file content
   */
  toEnvContent: (variables: EnvVariable[]): string => {
    const record: Record<string, string> = {};

    for (const variable of variables) {
      record[variable.key] = variable.value;
    }

    return serializeEnvContent(record);
  },
};
