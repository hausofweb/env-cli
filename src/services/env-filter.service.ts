import type { EnvLine, EnvVariable } from "../types/env-file.types";
import { envVariablePattern } from "../utils/env-parser";
import type { DirectiveScope } from "../utils/env-parser";

const appTagRegex = /#\s*@apps:\s*(?<apps>.+)/iu;
const globalDirectiveRegex = /#\s*@global/iu;

const applyDirective = (
  currentApps: DirectiveScope,
  directive: NonNullable<EnvLine["directive"]>
): DirectiveScope => {
  if (directive.type === "global") {
    return "global";
  }

  if (directive.type === "apps" && directive.apps) {
    return directive.apps;
  }

  return currentApps;
};

/**
 * Service for filtering environment variables by @apps directives
 */
export const EnvFilterService = {
  /**
   * Filter variables for a specific app
   */
  filterForApp: (content: string, appName: string): EnvVariable[] => {
    const lines = EnvFilterService.parseEnvLines(content);
    const variables: EnvVariable[] = [];

    // Track current filter state
    let currentApps: DirectiveScope = "global";

    for (const line of lines) {
      // Update filter state on directive
      if (line.type === "directive" && line.directive) {
        currentApps = applyDirective(currentApps, line.directive);
        continue;
      }

      // Add variable if it matches current filter
      if (line.type === "variable" && line.key && line.value !== undefined) {
        const shouldInclude =
          currentApps === "global" || currentApps.includes(appName);

        if (shouldInclude) {
          variables.push({
            key: line.key,
            value: line.value,
          });
        }
      }
    }

    return variables;
  },

  /**
   * Filter content for a specific app, preserving comments and empty lines
   * Returns formatted string with all comments and empty lines intact
   * Excludes @apps and @global directive comments
   */
  filterForAppWithFormatting: (content: string, appName: string): string => {
    const lines = EnvFilterService.parseEnvLines(content);
    const outputLines: string[] = [];

    // Track current filter state
    let currentApps: DirectiveScope = "global";

    for (const line of lines) {
      const isIncludedVariable =
        line.type === "variable" &&
        (currentApps === "global" || currentApps.includes(appName));

      if (line.type === "directive" && line.directive) {
        // Update filter state, but leave the directive itself out of the output
        currentApps = applyDirective(currentApps, line.directive);
      } else if (
        line.type === "comment" ||
        line.type === "empty" ||
        isIncludedVariable
      ) {
        outputLines.push(line.raw);
      }
    }

    return outputLines.join("\n");
  },

  /**
   * Normalize environment variable value by removing surrounding quotes
   */
  normalizeValue: (value: string): string => {
    const trimmed = value.trim();

    // Remove surrounding double quotes
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }

    // Remove surrounding single quotes
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  },

  /**
   * Parse directive from comment line
   * Returns null if not a directive comment
   */
  parseDirective: (line: string): EnvLine["directive"] | null => {
    // Check for @global directive
    if (globalDirectiveRegex.test(line)) {
      return { type: "global" };
    }

    // Check for @apps directive
    const appsList = appTagRegex.exec(line)?.groups?.apps;

    if (appsList) {
      const apps = appsList
        .split(",")
        .map((app) => app.trim())
        .filter(Boolean);

      return {
        apps,
        type: "apps",
      };
    }

    return null;
  },
  /**
   * Parse a single .env line; undefined when it is none of empty, directive,
   * comment or variable
   */
  parseEnvLine: (raw: string): EnvLine | undefined => {
    const trimmed = raw.trim();

    if (!trimmed) {
      return { raw, type: "empty" };
    }

    const directive = EnvFilterService.parseDirective(trimmed);

    if (directive) {
      return { directive, raw, type: "directive" };
    }

    if (trimmed.startsWith("#")) {
      return { raw, type: "comment" };
    }

    const match = envVariablePattern.exec(trimmed);

    if (!match) {
      return undefined;
    }

    const [, key] = match;
    const value = match[2] || match[3] || match[4];

    return {
      key,
      raw,
      type: "variable",
      value: EnvFilterService.normalizeValue(value),
    };
  },

  /**
   * Parse .env file content into structured lines
   */
  parseEnvLines: (content: string): EnvLine[] =>
    content.split("\n").flatMap((raw) => {
      const line = EnvFilterService.parseEnvLine(raw);

      return line ? [line] : [];
    }),
};
