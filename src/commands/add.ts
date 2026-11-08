import path from "node:path";
import { text } from "node:stream/consumers";

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";

import { ENVIRONMENTS } from "../constants/environments";
import { getEnvDir } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { EnvMergeService } from "../services/env-merge.service";
import { SopsService } from "../services/sops.service";
import type { SSMParameterType } from "../services/ssm.service";
import type { AppConfig, Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import { getEnvFileName } from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";
import { isExitPromptError } from "../utils/prompt-errors";
import { SHARED_DIR_NAME } from "../utils/variable-locations";
import {
  escapeEnvValue,
  promptValuesPerEnvironment,
} from "../utils/variable-value";
import { decryptEnvironment as defaultDecryptEnvironment } from "./decrypt";
import {
  handleSyncSSMCommand as defaultHandleSyncSSMCommand,
  INFRA_APP_NAME,
} from "./sync-ssm";
import { handleSyncCommand as defaultHandleSyncCommand } from "./sync-vercel";

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const TRAILING_NEWLINE = /\r?\n$/u;
const SSM_PARAMETER_TYPES = ["SecureString", "String"] as const;

/** Everything the `env add` wizard collects before writing the variable's files. */
interface AddVariableAnswers {
  /** Apps that see the variable; all of them yields `# @global`. */
  apps: AppConfig[];
  /** Environments whose `.env.<environment>.enc` (see `chooseHome`) gets the line. */
  environments: Environment[];
  /** Variable name, validated as SCREAMING_SNAKE_CASE and trimmed. */
  key: string;
  /** Sensitivity, written as a `# SecureString`/`# String` directive. */
  type: SSMParameterType;
  /** Value per selected environment, unescaped as the user typed it. */
  values: Map<Environment, string>;
}

/** `checkedNames` pre-selects those apps; without it every app starts checked. */
export const promptForApps = async (
  checkedNames?: Set<string>
): Promise<AppConfig[]> => {
  const allApps = await AppDiscoveryService.getAllApps();

  return checkbox<AppConfig>({
    choices: allApps.map((app) => ({
      checked: checkedNames?.has(app.name) ?? true,
      name: app.name,
      value: app,
    })),
    message: "Which apps should see this variable?",
    required: true,
  });
};

const promptForType = (): Promise<SSMParameterType> =>
  select({
    choices: [
      {
        name: 'SecureString (sensitive — encrypted; decryptable by authorized users, including as Vercel\'s plain "encrypted" type in the development environment)',
        value: "SecureString" as const,
      },
      {
        name: "String (not sensitive — readable, unencrypted)",
        value: "String" as const,
      },
    ],
    default: "SecureString",
    message: "Is this value sensitive?",
  });

const promptForAnswers = async (): Promise<AddVariableAnswers> => {
  const rawKey = await input({
    message: "Variable name (SCREAMING_SNAKE_CASE):",
    validate: (raw) =>
      KEY_PATTERN.test(raw.trim())
        ? true
        : "Must start with a letter or underscore, and contain only uppercase letters, digits, and underscores",
  });

  const key = rawKey.trim();

  const environments = await checkbox<Environment>({
    choices: ENVIRONMENTS.map((environment) => ({
      checked: true,
      name: environment,
      value: environment,
    })),
    message: "Which environments?",
    required: true,
  });

  const values = await promptValuesPerEnvironment(key, environments);

  return {
    apps: await promptForApps(),
    environments,
    key,
    type: await promptForType(),
    values,
  };
};

/** Options of `env add <KEY>`; passing a key makes the command non-interactive. */
export interface AddFlags {
  /** Comma-separated app folder names, e.g. `app,web`. */
  apps?: string;
  /** Comma-separated environments, e.g. `development,staging`. */
  env?: string;
  /** Run `env sync` / `env sync-ssm` for real after writing; skipped otherwise. */
  push?: boolean;
  /** `SecureString` (default) or `String`. */
  type?: string;
  /** The value inline; visible in shell history and `ps`, so only for non-secrets. */
  value?: string;
  /** Read the value from stdin, which keeps a secret out of argv. */
  valueStdin?: boolean;
}

const splitList = (raw: string | undefined, flag: string): string[] => {
  const items = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    throw new Error(`${flag} is required with a KEY`);
  }

  return items;
};

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error(
      "--value-stdin needs the value piped in, e.g. `… | env add KEY --value-stdin`"
    );
  }

  return await text(process.stdin);
};

const stripTrailingNewline = (raw: string): string =>
  raw.replace(TRAILING_NEWLINE, "");

/** One value for every environment, from exactly one of `--value` or `--value-stdin`. */
export const resolveFlagValue = async ({
  flags,
  readValue = readStdin,
}: {
  flags: AddFlags;
  /** Reads stdin; injectable so tests don't touch the process's stream. */
  readValue?: () => Promise<string>;
}): Promise<string> => {
  const hasInlineValue = flags.value !== undefined;

  if (hasInlineValue === Boolean(flags.valueStdin)) {
    throw new Error("Pass exactly one of --value or --value-stdin");
  }

  // `jq -r` and `echo` end the value with a newline that isn't part of it.
  const value = flags.value ?? stripTrailingNewline(await readValue());

  if (!value) {
    throw new Error("The value is empty");
  }

  return value;
};

/** The wizard's answers, built from flags; every name is checked against what exists. */
export const answersFromFlags = ({
  allApps,
  flags,
  key,
  value,
}: {
  allApps: AppConfig[];
  flags: AddFlags;
  key: string;
  /** From `resolveFlagValue`; written to every `--env`. */
  value: string;
}): AddVariableAnswers => {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`${key} is not SCREAMING_SNAKE_CASE`);
  }

  const environments = splitList(flags.env, "--env").map((name) => {
    const environment = ENVIRONMENTS.find((known) => known === name);

    if (!environment) {
      throw new Error(
        `Unknown environment ${name}; expected one of ${ENVIRONMENTS.join(", ")}`
      );
    }

    return environment;
  });

  const apps = splitList(flags.apps, "--apps").map((name) => {
    const app = allApps.find((known) => known.name === name);

    if (!app) {
      throw new Error(
        `Unknown app ${name}; expected one of ${allApps.map((known) => known.name).join(", ")}`
      );
    }

    return app;
  });

  const type = SSM_PARAMETER_TYPES.find(
    (known) => known === (flags.type ?? "SecureString")
  );

  if (!type) {
    throw new Error(`--type must be ${SSM_PARAMETER_TYPES.join(" or ")}`);
  }

  return {
    apps,
    environments,
    key,
    type,
    values: new Map(environments.map((environment) => [environment, value])),
  };
};

export const buildAppsDirective = (
  selectedApps: AppConfig[],
  allApps: AppConfig[]
): string => {
  const selectedNames = selectedApps.map((app) => app.name);
  const selectedNameSet = new Set(selectedNames);

  const isEveryAppSelected =
    allApps.length > 0 && allApps.every((app) => selectedNameSet.has(app.name));

  return isEveryAppSelected
    ? "# @global"
    : `# @apps: ${selectedNames.join(", ")}`;
};

/** One target owns the key in its own folder; several share it from shared/. */
export const chooseHome = ({
  allApps,
  targets,
}: {
  allApps: AppConfig[];
  /** Folder names of the targets that should see the key; not empty. */
  targets: Set<string>;
}) => {
  const selected = allApps.filter((app) => targets.has(app.name));

  return {
    destination: selected.length === 1 ? selected[0].name : SHARED_DIR_NAME,
    directive: buildAppsDirective(selected, allApps),
  };
};

type Home = ReturnType<typeof chooseHome>;

export const appendVariableLine = ({
  content,
  directives,
  key,
  value,
}: {
  /** Decrypted shared file; trailing whitespace is trimmed before appending. */
  content: string;
  /** Comment lines written above the variable: the `@apps`/`@global` line and its type. */
  directives: string[];
  /** Variable name; appended even if already present, so the new line wins. */
  key: string;
  /** Raw value; escaped and double-quoted on write. */
  value: string;
}): string => {
  const trimmed = content.trimEnd();
  const lines = trimmed ? [trimmed, "", ...directives] : [...directives];
  lines.push(`${key}="${escapeEnvValue(value)}"`);

  return `${lines.join("\n")}\n`;
};

const updateVariableFile = async ({
  directory,
  environment,
  key,
  mutate,
}: {
  /** Folder under `env/`: `shared` or the one app that sees the variable. */
  directory: string;
  /** Selects `.env.<environment>.enc` in that folder, created if missing. */
  environment: Environment;
  /** Only used to warn when the file already defines this variable. */
  key: string;
  /** Rewrites the decrypted content; its result is re-encrypted over the `.enc`. */
  mutate: (content: string) => string;
}): Promise<void> => {
  const envFileName = getEnvFileName(environment);
  const encPath = path.join(getEnvDir(), directory, `${envFileName}.enc`);
  const plaintextPath = path.join(getEnvDir(), directory, envFileName);

  const existing = (await FileOperations.fileExists(encPath))
    ? await SopsService.decrypt(encPath)
    : "";

  if (EnvMergeService.extractKeys(existing).has(key)) {
    output.warning(
      `  ${key} already exists in this file — appending anyway, the new value will win but the old line is left in place. Use \`env update\` to change a value in place instead.`
    );
  }

  await FileOperations.writeFile(plaintextPath, mutate(existing));
  await SopsService.encrypt(plaintextPath, encPath);
};

/** sync-ssm only reads variables whose targets include infra. */
const includesInfra = (apps: AppConfig[]): boolean =>
  apps.some((app) => app.name === INFRA_APP_NAME);

const syncTargetNames = (answers: AddVariableAnswers): string[] => {
  const targets: string[] = [];

  if (answers.apps.some((app) => app.type === "vercel")) {
    targets.push("Vercel");
  }

  if (includesInfra(answers.apps)) {
    targets.push("AWS SSM");
  }

  return targets;
};

const printSummary = (answers: AddVariableAnswers, home: Home): void => {
  output.section("Summary");
  output.log(`Variable: ${chalk.bold(answers.key)}`);
  output.log(`Type: ${answers.type}`);
  output.log(`Environments: ${answers.environments.join(", ")}`);
  output.log(`Apps: ${answers.apps.map((app) => app.name).join(", ")}`);

  output.log(chalk.cyan("\nEncrypted files to write"));

  for (const environment of answers.environments) {
    output.log(`  env/${home.destination}/${getEnvFileName(environment)}.enc`);
  }

  output.log("");
};

/** A one-app variable gets no `# @apps:` line: its folder already says who sees it. */
export const variableDirectives = (
  { destination, directive }: Home,
  type: SSMParameterType
): string[] => [
  ...(destination === SHARED_DIR_NAME ? [directive] : []),
  `# ${type}`,
];

const writeVariableFiles = async (
  answers: AddVariableAnswers,
  home: Home
): Promise<void> => {
  const { destination } = home;
  const directives = variableDirectives(home, answers.type);

  // sequential so console output stays readable and ordered
  await mapSequentially(answers.environments, async (environment) => {
    output.section(`Updating ${environment}`);

    const value = answers.values.get(environment);

    if (value === undefined) {
      throw new Error(`No value collected for environment: ${environment}`);
    }

    await updateVariableFile({
      directory: destination,
      environment,
      key: answers.key,
      mutate: (content) =>
        appendVariableLine({ content, directives, key: answers.key, value }),
    });
    output.success(
      `  Updated ${destination}/${getEnvFileName(environment)}.enc`
    );
  });
};

export interface AddCommandDependencies {
  /** Writes development's decrypted files back to disk. */
  decryptEnvironment: typeof defaultDecryptEnvironment;
  /** `env sync-ssm` for one environment; resolves true on failure. */
  handleSyncSSMCommand: typeof defaultHandleSyncSSMCommand;
  /** `env sync` (Vercel) for one environment; resolves true on failure. */
  handleSyncCommand: typeof defaultHandleSyncCommand;
}

export const createAddCommandSteps = ({
  decryptEnvironment,
  handleSyncCommand,
  handleSyncSSMCommand,
}: AddCommandDependencies) => {
  /**
   * Only development is decrypted back to disk (it feeds each app's .env.local).
   * Plaintext for every other environment — selected or not — is removed so
   * higher-env secrets never linger under env/ after the wizard.
   */
  const refreshLocalDecryptedFiles = async (
    environments: Environment[]
  ): Promise<void> => {
    output.section("Refreshing local decrypted files");
    const apps = await AppDiscoveryService.getAllApps();

    const envDirs = [
      path.join(getEnvDir(), SHARED_DIR_NAME),
      ...apps.map((app) => path.join(getEnvDir(), app.name)),
    ];

    if (environments.includes("development")) {
      await decryptEnvironment("development", apps, true);
    }

    const plaintextFileNames = ENVIRONMENTS.flatMap((environment) =>
      environment === "development" ? [] : [getEnvFileName(environment)]
    );

    await Promise.all(
      plaintextFileNames.flatMap((envFileName) =>
        envDirs.map((dir) =>
          FileOperations.removeFile(path.join(dir, envFileName))
        )
      )
    );

    for (const envFileName of plaintextFileNames) {
      output.success(`  Removed plaintext ${envFileName} from env/`);
    }
  };

  /** Returns whether any environment's sync failed. */
  const syncEnvironments = async ({
    dryRun,
    environments,
    shouldSyncSSM,
    shouldSyncVercel,
  }: {
    /** Passed to both syncs: preview the Vercel/SSM writes without making them. */
    dryRun: boolean;
    /** Synced one after another so console output stays in order. */
    environments: Environment[];
    /** Run `env sync-ssm` after Vercel for each environment. */
    shouldSyncSSM: boolean;
    /** Run `env sync` (Vercel); true when any selected app deploys to Vercel. */
    shouldSyncVercel: boolean;
  }): Promise<boolean> => {
    // sequential per environment so console output stays readable and ordered
    const failures = await mapSequentially(
      environments,
      async (environment) => {
        const vercelFailed = shouldSyncVercel
          ? await handleSyncCommand(environment, { dryRun })
          : false;

        if (!shouldSyncSSM) {
          return vercelFailed;
        }

        const ssmFailed = await handleSyncSSMCommand(environment, { dryRun });

        return vercelFailed || ssmFailed;
      }
    );

    return failures.includes(true);
  };

  return { refreshLocalDecryptedFiles, syncEnvironments };
};

export const { refreshLocalDecryptedFiles, syncEnvironments } =
  createAddCommandSteps({
    decryptEnvironment: defaultDecryptEnvironment,
    handleSyncCommand: defaultHandleSyncCommand,
    handleSyncSSMCommand: defaultHandleSyncSSMCommand,
  });

const syncTargets = async (answers: AddVariableAnswers): Promise<boolean> => {
  const targets = syncTargetNames(answers).join(" and ");

  if (!targets) {
    return false;
  }

  const choice = await select({
    choices: [
      { name: "Yes", value: "sync" as const },
      {
        name: "Dry run (preview only, no remote changes)",
        value: "dryRun" as const,
      },
      { name: "No, I'll sync later", value: "skip" as const },
    ],
    default: "sync",
    message: `Push ${answers.key} to ${targets} now? (The encrypted files are already saved.)`,
  });

  if (choice === "skip") {
    output.info(
      "Skipped. Run `env sync <environment>` / `env sync-ssm <environment>` when ready."
    );

    return false;
  }

  const dryRun = choice === "dryRun";

  const anyFailed = await syncEnvironments({
    dryRun,
    environments: answers.environments,
    shouldSyncSSM: includesInfra(answers.apps),
    shouldSyncVercel: answers.apps.some((app) => app.type === "vercel"),
  });

  if (dryRun) {
    output.info(
      "Dry run complete. Re-run `env sync <environment>` / `env sync-ssm <environment>` without --dry-run to apply for real."
    );
  }

  return anyFailed;
};

/** `--push` syncs for real; without it nothing leaves the encrypted files. */
const pushFromFlags = async (
  answers: AddVariableAnswers,
  shouldPush: boolean
): Promise<boolean> => {
  if (!shouldPush) {
    output.info(
      "Not pushed. Run `env sync <environment>` / `env sync-ssm <environment>` when ready, or pass --push."
    );

    return false;
  }

  return await syncEnvironments({
    dryRun: false,
    environments: answers.environments,
    shouldSyncSSM: includesInfra(answers.apps),
    shouldSyncVercel: answers.apps.some((app) => app.type === "vercel"),
  });
};

const collectAnswers = async ({
  allApps,
  flags,
  key,
}: {
  allApps: AppConfig[];
  flags: AddFlags;
  key?: string;
}): Promise<AddVariableAnswers> => {
  if (key) {
    const value = await resolveFlagValue({ flags });

    return answersFromFlags({ allApps, flags, key, value });
  }

  if (Object.keys(flags).length > 0) {
    throw new Error("Flags need a KEY: env add <KEY> --env … --apps …");
  }

  return await promptForAnswers();
};

export const addCommand = new Command("add")
  .description(
    "Add a new environment variable: an interactive wizard, or non-interactive when KEY is given"
  )
  .argument("[key]", "variable name; makes the command non-interactive")
  .option("--env <list>", "comma-separated environments")
  .option("--apps <list>", "comma-separated app names")
  .option("--type <type>", "SecureString (default) or String")
  .option("--value <value>", "the value inline (non-secrets only)")
  .option("--value-stdin", "read the value from stdin")
  .option("--push", "run env sync / env sync-ssm after writing")
  .action(async (key: string | undefined, flags: AddFlags) => {
    try {
      const allApps = await AppDiscoveryService.getAllApps();
      const answers = await collectAnswers({ allApps, flags, key });

      const home = chooseHome({
        allApps,
        targets: new Set(answers.apps.map((app) => app.name)),
      });

      printSummary(answers, home);

      const proceed =
        Boolean(key) ||
        (await confirm({
          default: true,
          message: `Write ${answers.key} to these encrypted files?`,
        }));

      if (!proceed) {
        output.info("Cancelled — nothing was written.");
        process.exit(0);
      }

      await checkAndAuthenticateAWS();
      SopsService.validateSopsInstalled();

      await writeVariableFiles(answers, home);
      await refreshLocalDecryptedFiles(answers.environments);

      output.log("");
      output.success(`${home.destination}/ files updated and re-encrypted.`);

      const syncFailed = key
        ? await pushFromFlags(answers, Boolean(flags.push))
        : await syncTargets(answers);

      process.exit(syncFailed ? 1 : 0);
    } catch (error) {
      if (isExitPromptError(error)) {
        output.info("\nCancelled.");
        process.exit(0);
      }

      if (error instanceof AWSCredentialsError) {
        outputAWSCredentialsError(error);
      } else {
        output.error(
          error instanceof Error ? error.message : "Add variable failed"
        );
      }

      process.exit(1);
    }
  });
