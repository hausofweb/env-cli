import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import { search, select } from "@inquirer/prompts";
import { Command } from "commander";

import { ENVIRONMENTS } from "../constants/environments";
import { getEnvDir } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { SopsService } from "../services/sops.service";
import type { Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import {
  findVariableScope,
  getEnvFileName,
  parseEnvContent,
} from "../utils/env-parser";
import type { DirectiveScope } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";
import { ProcessExecutor } from "../utils/process-executor";
import { isExitPromptError } from "../utils/prompt-errors";
import {
  envDirectoryNames,
  SHARED_DIR_NAME,
} from "../utils/variable-locations";

/** Below this length, four characters would give away too much of the value. */
const MIN_LENGTH_FOR_PREFIX = 12;
const MASK_PREFIX_LENGTH = 4;

/** One file's definition of a variable, decrypted in memory only. */
export interface VariableDefinition {
  /** Folder under env/: `shared` or a target name. */
  directory: string;
  key: string;
  /** For `shared/`, the targets its `# @apps:` / `# @global` directive names. */
  scope?: DirectiveScope;
  value: string;
}

/** `sk_t… (107 chars)`; short values show only their length. */
export const maskValue = (value: string): string => {
  const length = `(${value.length} chars)`;

  if (value.length < MIN_LENGTH_FOR_PREFIX) {
    return `… ${length}`;
  }

  return `${value.slice(0, MASK_PREFIX_LENGTH)}… ${length}`;
};

/** `api` or `shared (@apps: api, web)` / `shared (@global)`. */
export const describeDefinition = ({
  directory,
  scope,
}: Pick<VariableDefinition, "directory" | "scope">): string => {
  if (!scope) {
    return directory;
  }

  return scope === "global"
    ? `${directory} (@global)`
    : `${directory} (@apps: ${scope.join(", ")})`;
};

export interface ReadDefinitionsDependencies {
  /** Decrypts one `.enc` file to a string; plaintext never touches disk. */
  decrypt: (encPath: string) => Promise<string>;
  /** Folders to read: `shared` plus one per target. */
  directories: () => Promise<string[]>;
  fileExists: (filePath: string) => Promise<boolean>;
}

/** Every variable defined in `environment`, grouped by key. */
export const createReadDefinitions =
  ({ decrypt, directories, fileExists }: ReadDefinitionsDependencies) =>
  async (
    environment: Environment
  ): Promise<Map<string, VariableDefinition[]>> => {
    const definitions = new Map<string, VariableDefinition[]>();

    // each decrypt is a sops subprocess; running them all at once floods KMS
    await mapSequentially(await directories(), async (directory) => {
      const encPath = path.join(
        getEnvDir(),
        directory,
        `${getEnvFileName(environment)}.enc`
      );

      if (!(await fileExists(encPath))) {
        return;
      }

      const content = await decrypt(encPath);

      // ponytail: one definition per file (the last, as dotenv reads it); a key
      // defined twice in shared/ under different @apps blocks shows only the last.
      for (const [key, value] of Object.entries(parseEnvContent(content))) {
        const existing = definitions.get(key) ?? [];
        existing.push(
          directory === SHARED_DIR_NAME
            ? {
                directory,
                key,
                scope: findVariableScope({ content, key }),
                value,
              }
            : { directory, key, value }
        );
        definitions.set(key, existing);
      }
    });

    return definitions;
  };

export const readDefinitions = createReadDefinitions({
  decrypt: (encPath) => SopsService.decrypt(encPath),
  directories: envDirectoryNames,
  fileExists: (filePath) => FileOperations.fileExists(filePath),
});

/**
 * What `target` actually sees: its own file's copy wins over `shared/`
 * (EnvMergeService.merge), and a shared copy counts only when its directive
 * includes the target.
 */
export const definitionsForTarget = ({
  definitions,
  target,
}: {
  definitions: VariableDefinition[];
  target: string;
}): VariableDefinition[] => {
  const own = definitions.filter(({ directory }) => directory === target);

  if (own.length > 0) {
    return own;
  }

  return definitions.filter(
    ({ directory, scope }) =>
      directory === SHARED_DIR_NAME &&
      (scope === "global" || scope?.includes(target))
  );
};

/** A clipboard program that reads the text to copy from its stdin. */
interface ClipboardCommand {
  args: string[];
  command: string;
}

const CLIPBOARD_COMMANDS: Partial<Record<NodeJS.Platform, ClipboardCommand[]>> =
  {
    darwin: [{ args: [], command: "pbcopy" }],
    linux: [
      { args: [], command: "wl-copy" },
      { args: ["-selection", "clipboard"], command: "xclip" },
      { args: ["--clipboard", "--input"], command: "xsel" },
    ],
    win32: [{ args: [], command: "clip" }],
  };

export interface ClipboardDependencies {
  /** Whether a program is on PATH (`which`); not consulted for Windows' built-in `clip`. */
  commandExists: (command: string) => boolean;
  /** Runs `command` with `input` on its stdin, resolving once it exits 0. */
  pipeToCommand: (
    options: ClipboardCommand & { input: string }
  ) => Promise<void>;
  platform: NodeJS.Platform;
}

/** Copies `value` through the OS clipboard tool's stdin, never its argv, so it can't show up in `ps`. */
export const createWriteToClipboard =
  ({ commandExists, pipeToCommand, platform }: ClipboardDependencies) =>
  async (value: string): Promise<void> => {
    const candidates = CLIPBOARD_COMMANDS[platform] ?? [];

    const clipboard =
      platform === "win32"
        ? candidates[0]
        : candidates.find(({ command }) => commandExists(command));

    if (!clipboard) {
      const names = candidates.map(({ command }) => command).join(", ");
      throw new Error(
        names
          ? `No clipboard tool found. Install one of: ${names}.`
          : `Copying to the clipboard isn't supported on ${platform}.`
      );
    }

    await pipeToCommand({ ...clipboard, input: value });
  };

const pipeToStdin = async ({
  args,
  command,
  input,
}: ClipboardCommand & { input: string }): Promise<void> => {
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "inherit"] });
  child.stdin.end(input);
  const [exitCode]: (number | null)[] = await once(child, "close");

  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}`);
  }
};

const writeToSystemClipboard = createWriteToClipboard({
  commandExists: (command) => ProcessExecutor.commandExists(command),
  pipeToCommand: pipeToStdin,
  platform: process.platform,
});

export interface CopyVariableDependencies {
  /** Picks one of several definitions whose values differ. */
  chooseDefinition: (
    definitions: VariableDefinition[]
  ) => Promise<VariableDefinition>;
  writeToClipboard: (value: string) => Promise<void>;
}

/**
 * Copies the value of `key` and returns the definition copied. Identical
 * copies across folders are one value; differing ones go to the user to pick,
 * since guessing would hand over the wrong secret without saying so.
 */
export const createCopyVariable =
  ({ chooseDefinition, writeToClipboard }: CopyVariableDependencies) =>
  async ({
    definitions,
    key,
    target,
  }: {
    /** Every definition of `key` in the environment. */
    definitions: VariableDefinition[];
    key: string;
    /** Only what this target sees, when given. */
    target?: string;
  }): Promise<VariableDefinition> => {
    const candidates = target
      ? definitionsForTarget({ definitions, target })
      : definitions;

    const [first] = candidates;

    if (!first) {
      throw new Error(
        target
          ? `${key} is not visible to ${target}.`
          : `${key} is not defined.`
      );
    }

    const hasOneValue = candidates.every(({ value }) => value === first.value);
    const chosen = hasOneValue ? first : await chooseDefinition(candidates);
    await writeToClipboard(chosen.value);

    return chosen;
  };

const promptForDefinition = (
  definitions: VariableDefinition[]
): Promise<VariableDefinition> =>
  select({
    choices: definitions.map((definition) => ({
      name: `${describeDefinition(definition)}  ${maskValue(definition.value)}`,
      value: definition,
    })),
    message: `${definitions[0]?.key} has different values per target. Which one?`,
  });

export const copyVariable = createCopyVariable({
  chooseDefinition: promptForDefinition,
  writeToClipboard: writeToSystemClipboard,
});

const describeKey = (definitions: VariableDefinition[]): string => {
  const where = definitions.map(describeDefinition).join(", ");
  const values = new Set(definitions.map(({ value }) => value));
  const [only] = definitions;

  const preview =
    values.size === 1 && only
      ? maskValue(only.value)
      : `${values.size} different values`;

  return `${where} · ${preview}`;
};

const promptForKey = (
  definitions: Map<string, VariableDefinition[]>
): Promise<string> => {
  const keys = [...definitions.keys()].toSorted();

  return search<string>({
    message: `Which variable? (${keys.length} defined, type to narrow)`,
    source: (term) => {
      const needle = term?.trim().toUpperCase() ?? "";

      return keys.flatMap((key) =>
        key.includes(needle)
          ? [
              {
                description: describeKey(definitions.get(key) ?? []),
                name: key,
                value: key,
              },
            ]
          : []
      );
    },
  });
};

const resolveEnvironment = async (
  environmentArg: string | undefined
): Promise<Environment> => {
  if (!environmentArg) {
    return await select({
      choices: ENVIRONMENTS.map((environment) => ({
        name: environment,
        value: environment,
      })),
      message: "Select an environment:",
    });
  }

  const match = ENVIRONMENTS.find((candidate) => candidate === environmentArg);

  if (!match) {
    throw new Error(
      `Invalid environment: ${environmentArg}. Must be one of: ${ENVIRONMENTS.join(", ")}`
    );
  }

  return match;
};

export const copyCommand = new Command("copy")
  .description(
    "Copy one variable's decrypted value to the clipboard (shows only a masked preview)"
  )
  .argument("[key]", "Variable name; omit to pick from a searchable list")
  .option(
    "--env <environment>",
    "Environment (production, staging, preview, development)"
  )
  .option(
    "--target <target>",
    "Copy what this target sees: its own file's value, else shared/ when tagged for it"
  )
  .action(
    async (
      keyArg: string | undefined,
      options: {
        /** `--env`: environment to read; prompted for when omitted. */
        env?: string;
        /** `--target`: narrow to the value this target sees. */
        target?: string;
      }
    ) => {
      try {
        const environment = await resolveEnvironment(options.env);

        await checkAndAuthenticateAWS();
        SopsService.validateSopsInstalled();

        output.info(`Reading ${environment}...`);
        const definitions = await readDefinitions(environment);

        const key = keyArg ?? (await promptForKey(definitions));
        const keyDefinitions = definitions.get(key);

        if (!keyDefinitions) {
          throw new Error(`${key} is not defined in ${environment}.`);
        }

        const copied = await copyVariable({
          definitions: keyDefinitions,
          key,
          target: options.target,
        });

        output.success(
          `Copied ${key} (${environment}, ${describeDefinition(copied)}) to the clipboard: ${maskValue(copied.value)}`
        );
        process.exit(0);
      } catch (error) {
        if (isExitPromptError(error)) {
          output.info("\nCancelled.");
          process.exit(0);
        }

        if (error instanceof AWSCredentialsError) {
          outputAWSCredentialsError(error);
        } else {
          output.error(error instanceof Error ? error.message : "Copy failed");
        }

        process.exit(1);
      }
    }
  );
