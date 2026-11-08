import { ENV_FILE_NAMES } from "../constants/environments";
import type { SSMParameterType } from "../services/ssm.service";
import type { Environment } from "../types/app-config.types";

/**
 * Regular expression to match environment variable lines in .env files.
 * Groups stay positional too (key = 1, doubleQuoted = 3, singleQuoted = 4, bare = 5).
 * @see https://regex101.com/r/82uAlF/1
 */
export const envVariablePattern =
  /^(?<key>[A-Z_][A-Z0-9_]*)\s*=\s*(?<rawValue>"(?<doubleQuoted>[^"]*)"|'(?<singleQuoted>[^']*)'|(?<bare>[^#\s]+))/u;

const SSM_TYPE_ANNOTATION_PATTERN = /^#\s*(?<type>String|SecureString)$/u;
const APP_DIRECTIVE_PATTERN = /^#\s*@apps:\s*(?<apps>.+)/iu;
const GLOBAL_DIRECTIVE_PATTERN = /^#\s*@global/iu;

/** Variable name to its unquoted value. */
type EnvVariables = Record<string, string>;

/**
 * Parse .env file content into key-value pairs
 */
export const parseEnvContent = (content: string): EnvVariables => {
  const result: EnvVariables = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Match KEY=VALUE pattern
    const match = envVariablePattern.exec(trimmed);

    if (match) {
      const [, key] = match;
      result[key] = match[3] || match[4] || match[5];
    }
  }

  return result;
};

/**
 * Normalize environment variable value by removing surrounding quotes
 */
export const normalizeValue = (value: string): string => {
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
};

/**
 * Serialize key-value pairs back to .env format
 */
export const serializeEnvContent = (variables: EnvVariables): string =>
  Object.entries(variables)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

export const getEnvFileName = (environment: Environment) =>
  ENV_FILE_NAMES[environment];

/**
 * Apps the lines below a directive apply to: the names from `# @apps: ...`,
 * or `"global"` under `# @global` and before any directive.
 */
export type DirectiveScope = string[] | "global";

const parseScopeDirective = (trimmed: string): DirectiveScope | undefined => {
  if (GLOBAL_DIRECTIVE_PATTERN.test(trimmed)) {
    return "global";
  }

  return APP_DIRECTIVE_PATTERN.exec(trimmed)
    ?.groups?.apps.split(",")
    .map((app) => app.trim())
    .filter(Boolean);
};

/**
 * Scope of the last line defining `key` (the one that wins), or undefined
 * when the content doesn't define it.
 */
export const findVariableScope = ({
  content,
  key,
}: {
  /** Decrypted env file text. */
  content: string;
  /** Variable name; matches only lines starting with `<key>=`. */
  key: string;
}): DirectiveScope | undefined => {
  let currentApps: DirectiveScope = "global";
  let keyScope: DirectiveScope | undefined;

  for (const line of content.split("\n")) {
    const scope = parseScopeDirective(line.trim());

    if (scope) {
      currentApps = scope;
    } else if (line.startsWith(`${key}=`)) {
      keyScope = currentApps;
    }
  }

  return keyScope;
};

export const parseSSMTypeAnnotation = (
  trimmed: string
): SSMParameterType | undefined => {
  const annotatedType = SSM_TYPE_ANNOTATION_PATTERN.exec(trimmed)?.groups?.type;

  if (!annotatedType) {
    return undefined;
  }

  return annotatedType === "SecureString" ? "SecureString" : "String";
};

/** The key of the first variable line after an annotation, skipping blanks and comments. */
const findAnnotatedVariableKey = (
  lines: string[],
  annotationIndex: number
): string | undefined => {
  const nextLine = lines.slice(annotationIndex + 1).find((line) => {
    const trimmed = line.trim();

    return trimmed && !trimmed.startsWith("#");
  });

  return nextLine
    ? envVariablePattern.exec(nextLine.trim())?.groups?.key
    : undefined;
};

/**
 * Parse "# String" / "# SecureString" annotations, keyed by variable name.
 *
 * When `appName` is given, an annotation under a "# @apps: ..." directive
 * that doesn't list `appName` (and isn't under "# @global") is skipped —
 * otherwise, if the same key were ever annotated differently under two
 * different app-scoped blocks, the last one in the file would silently win
 * for every app, not just the one it was scoped for.
 */
export const parseSSMTypeAnnotations = (
  content: string,
  appName?: string
): Map<string, SSMParameterType> => {
  const result = new Map<string, SSMParameterType>();
  const lines = content.split("\n");
  let currentApps: DirectiveScope = "global";

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();

    const scope = parseScopeDirective(trimmed);

    if (scope) {
      currentApps = scope;
      continue;
    }

    const type = parseSSMTypeAnnotation(trimmed);

    const inScope =
      !appName || currentApps === "global" || currentApps.includes(appName);

    const key =
      type && inScope ? findAnnotatedVariableKey(lines, index) : undefined;

    if (type && key) {
      result.set(key, type);
    }
  }

  return result;
};
