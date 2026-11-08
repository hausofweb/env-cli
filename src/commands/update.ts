import path from "node:path";

import { checkbox, confirm } from "@inquirer/prompts";
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
import { EnvFilterService } from "../services/env-filter.service";
import { SopsService } from "../services/sops.service";
import type { AppConfig, Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import {
  findVariableScope,
  getEnvFileName,
  parseSSMTypeAnnotation,
} from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";
import {
  assertProductionConfirmed,
  authenticateForSops,
  collectOption,
  parseEnvironments,
  selectLocations,
} from "../utils/non-interactive";
import { isExitPromptError } from "../utils/prompt-errors";
import {
  collectKeyLocations,
  promptForKey,
  SHARED_DIR_NAME,
} from "../utils/variable-locations";
import type { KeyLocation } from "../utils/variable-locations";
import {
  escapeEnvValue,
  promptValuesPerEnvironment,
} from "../utils/variable-value";
import {
  chooseHome,
  promptForApps,
  refreshLocalDecryptedFiles,
  resolveFlagValue,
  syncEnvironments,
} from "./add";

/**
 * Rewrites every line defining `key`, in place, keeping the `# @apps:` /
 * `# SecureString` directives above it — those describe who sees the variable
 * and how it syncs, which a value rotation does not change.
 *
 * Every matching line is replaced rather than just the first: `env add` on an
 * existing key appends a second definition and leaves the old line behind, so
 * files can legitimately carry duplicates that all have to go.
 */
export const replaceVariableLine = ({
  content,
  key,
  value,
}: {
  /** Decrypted env file text; directive lines pass through untouched. */
  content: string;
  /** Variable name; matches only lines starting with `<key>=`. */
  key: string;
  /** New raw value; escaped and double-quoted on every matching line. */
  value: string;
}) => {
  const prefix = `${key}=`;
  let replaced = 0;

  const lines = content.split("\n").map((line) => {
    if (!line.startsWith(prefix)) {
      return line;
    }

    replaced += 1;

    return `${key}="${escapeEnvValue(value)}"`;
  });

  return { content: lines.join("\n"), replaced };
};

/**
 * Index of the `# String` / `# SecureString` line that annotates the variable
 * at `variableIndex`: the nearest one above it with only blanks and comments
 * between, matching how `parseSSMTypeAnnotations` pairs them.
 */
const findAnnotationIndex = (
  lines: string[],
  variableIndex: number
): number | undefined => {
  for (let index = variableIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();

    if (parseSSMTypeAnnotation(trimmed)) {
      return index;
    }

    if (trimmed && !trimmed.startsWith("#")) {
      return undefined;
    }
  }

  return undefined;
};

/**
 * Pulls every definition of `key`, and the type annotation above it, out of
 * `content`. The last definition is the one returned because it is the one
 * that wins when the file is parsed.
 */
const takeVariable = ({ content, key }: { content: string; key: string }) => {
  const lines = content.split("\n");
  const removedIndexes = new Set<number>();
  let definition: string | undefined;
  let annotationIndex: number | undefined;

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith(`${key}=`)) {
      continue;
    }

    definition = line;
    annotationIndex = findAnnotationIndex(lines, index);
    removedIndexes.add(index);

    if (annotationIndex !== undefined) {
      removedIndexes.add(annotationIndex);
    }
  }

  const annotation =
    annotationIndex === undefined ? undefined : lines[annotationIndex].trim();

  const remaining = lines
    .filter((_line, index) => !removedIndexes.has(index))
    .join("\n")
    .trimEnd();

  return { annotation, definition, remaining };
};

const appendBlock = ({
  block,
  remaining,
}: {
  /** Directive (if any), annotation (if any) and the raw definition line. */
  block: string[];
  /** File text with the variable already taken out. */
  remaining: string;
}) => `${(remaining ? [remaining, "", ...block] : block).join("\n")}\n`;

/**
 * Moves `key` into its own block at the end of the file under `directive`,
 * carrying its type annotation and raw line over unchanged, so its value is
 * never re-entered or re-escaped. Every definition and its annotation is
 * removed from where it was, and the other variables in that block keep their
 * scope because the block's own `# @apps:` line stays.
 */
export const rescopeVariableLine = ({
  content,
  directive,
  key,
}: {
  /** Decrypted env file text. */
  content: string;
  /** `# @apps: ...` or `# @global` line, from `buildAppsDirective`. */
  directive: string;
  /** Variable name; matches only lines starting with `<key>=`. */
  key: string;
}) => {
  const { annotation, definition, remaining } = takeVariable({ content, key });

  if (definition === undefined) {
    return { content, moved: false };
  }

  return {
    content: appendBlock({
      block: [directive, ...(annotation ? [annotation] : []), definition],
      remaining,
    }),
    moved: true,
  };
};

const definitionValue = (definition: string): string | undefined =>
  EnvFilterService.parseEnvLine(definition)?.value;

/**
 * Plans moving `key` to where its audience says it belongs for one
 * environment: a single target keeps it in that target's own file, several
 * targets share it from shared/ under `directive`. Value and type annotation
 * travel unchanged. Pure: `contents` holds the decrypted text of every file
 * that defines the key plus the destination's (empty when it has none), and the
 * result holds only the files whose text changes.
 *
 * A key holding different values in the files involved is a conflict, because
 * merging would silently discard one of them.
 */
export const planRescope = ({
  contents,
  destination,
  directive,
  key,
}: {
  /** Decrypted text by folder under `env/`; must include `destination`. */
  contents: Record<string, string>;
  /** Folder that ends up owning the key: `shared` or the one target. */
  destination: string;
  /** `# @apps:` / `# @global` line; only written when the destination is shared. */
  directive: string;
  /** Variable being moved. */
  key: string;
}): { changes: Record<string, string> } | { conflict: string } => {
  const taken = Object.entries(contents).map(([directory, content]) => ({
    directory,
    ...takeVariable({ content, key }),
  }));

  const defined = taken.filter(({ definition }) => definition !== undefined);

  const carried =
    defined.find(({ directory }) => directory !== destination) ?? defined[0];

  if (carried?.definition === undefined) {
    return { changes: {} };
  }

  const values = new Set(
    defined.map(({ definition }) => definitionValue(definition ?? ""))
  );

  if (values.size > 1) {
    const where = defined.map(({ directory }) => `${directory}/`).join(", ");

    return {
      conflict: `${key} holds different values in ${where}; reconcile them with \`env update\` first so nothing is lost.`,
    };
  }

  const isShared = destination === SHARED_DIR_NAME;

  const isAlreadyHome =
    !isShared && defined.length === 1 && defined[0].directory === destination;

  if (isAlreadyHome) {
    return { changes: {} };
  }

  const changes: Record<string, string> = {};

  for (const { definition, directory, remaining } of taken) {
    if (directory !== destination && definition !== undefined) {
      changes[directory] = remaining === "" ? "" : `${remaining}\n`;
    }
  }

  const { annotation, definition } = carried;
  const home = taken.find(({ directory }) => directory === destination);
  changes[destination] = appendBlock({
    block: [
      ...(isShared ? [directive] : []),
      ...(annotation ? [annotation] : []),
      definition,
    ],
    remaining: home?.remaining ?? "",
  });

  return { changes };
};

const encryptedFilePaths = ({
  directory,
  environment,
}: {
  /** Folder under `env/` (`shared` or an app) holding the file. */
  directory: string;
  /** Selects `.env.<environment>.enc` in that folder. */
  environment: Environment;
}) => {
  const envFileName = getEnvFileName(environment);

  return {
    encPath: path.join(getEnvDir(), directory, `${envFileName}.enc`),
    plaintextPath: path.join(getEnvDir(), directory, envFileName),
  };
};

export const rewriteLocation = async ({
  directory,
  environment,
  key,
  value,
}: {
  /** Folder under `env/` (`shared` or an app) holding the file. */
  directory: string;
  /** Selects `.env.<environment>.enc` in that folder, re-encrypted in place. */
  environment: Environment;
  /** Variable whose every definition is rewritten. */
  key: string;
  /** Replacement value collected for this environment. */
  value: string;
}): Promise<number> => {
  const { encPath, plaintextPath } = encryptedFilePaths({
    directory,
    environment,
  });

  const existing = await SopsService.decrypt(encPath);

  const { content, replaced } = replaceVariableLine({
    content: existing,
    key,
    value,
  });

  await FileOperations.writeFile(plaintextPath, content);
  await SopsService.encrypt(plaintextPath, encPath);

  return replaced;
};

const printLocations = (key: string, locations: KeyLocation[]): void => {
  output.section("Found");

  for (const { directory, environment } of locations) {
    output.log(
      `  ${chalk.bold(key)} in ${directory}/${getEnvFileName(environment)}.enc`
    );
  }

  output.log("");
};

/** The SSM question is asked only after the Vercel one, so it reads as a follow-up. */
const promptSyncTargets = async (): Promise<{
  shouldSync: boolean;
  shouldSyncSSM: boolean;
}> => {
  const shouldSync = await confirm({
    default: true,
    message: "Push the new value to Vercel now?",
  });

  return {
    shouldSync,
    shouldSyncSSM: await confirm({
      default: false,
      message: "Also push to AWS SSM (only keys in env.config.json ssm sync)?",
    }),
  };
};

const syncAfterUpdate = async (
  environments: Environment[]
): Promise<boolean> => {
  const { shouldSync, shouldSyncSSM } = await promptSyncTargets();

  if (!(shouldSync || shouldSyncSSM)) {
    output.info(
      "Skipped sync. Run `env sync <environment>` / `env sync-ssm <environment>` when ready."
    );

    return false;
  }

  const dryRun = await confirm({
    default: true,
    message:
      "Dry run first (no remote changes; local files are already updated)?",
  });

  const anyFailed = await syncEnvironments({
    dryRun,
    environments,
    shouldSyncSSM,
    shouldSyncVercel: shouldSync,
  });

  if (dryRun) {
    output.info(
      "Dry run complete. Re-run without --dry-run to apply for real."
    );
  }

  return anyFailed;
};

const CANCELLED_MESSAGE = "Cancelled.";

const confirmOrExit = async (message: string): Promise<void> => {
  const proceed = await confirm({ default: true, message });

  if (!proceed) {
    output.info(CANCELLED_MESSAGE);
    process.exit(0);
  }
};

interface EnvFile {
  /** Decrypted text; empty when the file does not exist yet. */
  content: string;
  encPath: string;
  plaintextPath: string;
}

export interface LoadedEnvironment {
  /** Targets that see the key today: `# @apps:` names from shared/ plus each folder defining it. */
  audience: Set<string>;
  environment: Environment;
  /** Every file defining the key in this environment, by folder. */
  files: Map<string, EnvFile>;
}

const readEnvFile = async ({
  directory,
  environment,
}: {
  directory: string;
  environment: Environment;
}): Promise<EnvFile> => {
  const paths = encryptedFilePaths({ directory, environment });

  const content = (await FileOperations.fileExists(paths.encPath))
    ? await SopsService.decrypt(paths.encPath)
    : "";

  return { ...paths, content };
};

const contentsOf = (files: Map<string, EnvFile>): Record<string, string> =>
  Object.fromEntries(
    [...files].map(([directory, { content }]) => [directory, content])
  );

/**
 * Who sees `key`: a target folder's own file is seen by that target alone,
 * while a shared/ definition is seen by whoever its `# @apps:` tag (or
 * `# @global`) names.
 */
export const variableAudience = ({
  allApps,
  contents,
  key,
}: {
  allApps: AppConfig[];
  /** Decrypted text by folder under `env/`. */
  contents: Record<string, string>;
  key: string;
}): Set<string> => {
  const namesIn = (directory: string, content: string): string[] => {
    if (takeVariable({ content, key }).definition === undefined) {
      return [];
    }

    if (directory !== SHARED_DIR_NAME) {
      return [directory];
    }

    const scope = findVariableScope({ content, key });

    return scope === "global" ? allApps.map((app) => app.name) : (scope ?? []);
  };

  return new Set(
    Object.entries(contents).flatMap(([directory, content]) =>
      namesIn(directory, content)
    )
  );
};

/** Reads every file defining `key`, once per environment, in a stable order. */
export const loadEnvironments = async ({
  allApps,
  key,
  locations,
}: {
  allApps: AppConfig[];
  key: string;
  /** Every file defining `key`, across environments. */
  locations: KeyLocation[];
}): Promise<LoadedEnvironment[]> => {
  const environments = ENVIRONMENTS.filter((environment) =>
    locations.some((location) => location.environment === environment)
  );

  // sequential: one sops run at a time keeps KMS calls and output in order
  return await mapSequentially(environments, async (environment) => {
    const directories = locations.flatMap((location) =>
      location.environment === environment ? [location.directory] : []
    );

    const entries = await mapSequentially(directories, async (directory) => {
      const file = await readEnvFile({ directory, environment });

      return [directory, file] as const;
    });

    const files = new Map(entries);

    return {
      audience: variableAudience({ allApps, contents: contentsOf(files), key }),
      environment,
      files,
    };
  });
};

export interface EnvironmentPlan {
  environment: Environment;
  /** Includes the destination file, read even when it did not define the key. */
  files: Map<string, EnvFile>;
  result: ReturnType<typeof planRescope>;
}

/** Plans one loaded environment so exactly `targets` see the key. */
export const planTargets = async ({
  allApps,
  key,
  loaded,
  targets,
}: {
  allApps: AppConfig[];
  key: string;
  loaded: LoadedEnvironment;
  /** Folder names that should see the key; not empty. */
  targets: Set<string>;
}): Promise<EnvironmentPlan> => {
  const { destination, directive } = chooseHome({ allApps, targets });
  const files = new Map(loaded.files);

  if (!files.has(destination)) {
    files.set(
      destination,
      await readEnvFile({
        directory: destination,
        environment: loaded.environment,
      })
    );
  }

  return {
    environment: loaded.environment,
    files,
    result: planRescope({
      contents: contentsOf(files),
      destination,
      directive,
      key,
    }),
  };
};

export const hasVariables = (content: string): boolean =>
  EnvFilterService.parseEnvLines(content).some(
    ({ type }) => type === "variable"
  );

export interface WriteChangesDependencies {
  /** Re-encrypts a plaintext file over its `.enc`. */
  encrypt: typeof SopsService.encrypt;
  removeFile: typeof FileOperations.removeFile;
  writeFile: typeof FileOperations.writeFile;
}

/**
 * Writes each changed file and re-encrypts it over its `.enc`. A file left with
 * no variables is deleted instead: sops cannot encrypt an empty dotenv, and
 * every reader (`decrypt`, `sync`, `sync-ssm`) already treats a missing file as
 * empty.
 */
export const writeChanges = async ({
  changes,
  dependencies = {
    encrypt: SopsService.encrypt,
    removeFile: FileOperations.removeFile,
    writeFile: FileOperations.writeFile,
  },
  environment,
  files,
}: {
  /** New plaintext by folder. */
  changes: Record<string, string>;
  dependencies?: WriteChangesDependencies;
  environment: Environment;
  files: Map<string, EnvFile>;
}): Promise<void> => {
  // sequential so console output stays readable and ordered
  await mapSequentially(
    Object.entries(changes),
    async ([directory, content]) => {
      const file = files.get(directory);

      if (!file) {
        throw new Error(`No file loaded for ${directory}/`);
      }

      const name = `${directory}/${getEnvFileName(environment)}.enc`;

      if (hasVariables(content)) {
        await dependencies.writeFile(file.plaintextPath, content);
        await dependencies.encrypt(file.plaintextPath, file.encPath);
        output.success(`  ${name} — updated`);

        return;
      }

      await dependencies.removeFile(file.encPath);
      await dependencies.removeFile(file.plaintextPath);
      output.success(`  ${name} — no variables left, file deleted`);
    }
  );
};

export const applyPlans = async (plans: EnvironmentPlan[]): Promise<void> => {
  await mapSequentially(plans, async ({ environment, files, result }) => {
    if ("changes" in result) {
      await writeChanges({ changes: result.changes, environment, files });
    }
  });
};

/** Returns the environments whose values were rewritten. */
const updateValues = async ({
  environments,
  key,
  locations,
}: {
  /** Environments the user picked; ones without the key are skipped. */
  environments: Environment[];
  /** Variable whose value is replaced. */
  key: string;
  /** Every file defining `key` in those environments. */
  locations: KeyLocation[];
}): Promise<Environment[]> => {
  // Only environments that actually hold the key — a rotation shouldn't
  // prompt for a value it has nowhere to write.
  const found = ENVIRONMENTS.filter((environment) =>
    locations.some((location) => location.environment === environment)
  );

  const foundEnvironments = new Set(found);

  const missing = environments.filter(
    (environment) => !foundEnvironments.has(environment)
  );

  if (missing.length > 0) {
    output.warning(`  Not defined in ${missing.join(", ")} — skipping those.`);
  }

  const values = await promptValuesPerEnvironment(key, found);
  await confirmOrExit(`Replace ${key} in ${locations.length} file(s)?`);

  // sequential so console output stays readable and ordered
  await mapSequentially(locations, async ({ directory, environment }) => {
    const value = values.get(environment);

    if (value === undefined) {
      throw new Error(`No value collected for environment: ${environment}`);
    }

    const replaced = await rewriteLocation({
      directory,
      environment,
      key,
      value,
    });

    output.success(
      `  ${directory}/${getEnvFileName(environment)}.enc — replaced ${replaced} line(s)`
    );
  });

  return found;
};

const validateAppNames = ({
  allApps,
  names,
}: {
  allApps: AppConfig[];
  names: string[];
}): Set<string> => {
  for (const name of names) {
    if (!allApps.some((app) => app.name === name)) {
      throw new Error(
        `Unknown app ${name}; expected one of ${allApps.map((app) => app.name).join(", ")}`
      );
    }
  }

  return new Set(names);
};

/**
 * Re-targets `key` in every selected environment. One target keeps it in that
 * target's own file; several share it from shared/ under a `# @apps:` tag,
 * which is also what decides SSM (sync-ssm reads shared/ variables tagged
 * infra, plus infra/). Returns the environments whose files changed.
 */
const updateApps = async ({
  key,
  locations,
  targetNames,
}: {
  /** Variable whose audience is replaced. */
  key: string;
  /** Every file defining `key`, in shared/ and in target folders. */
  locations: KeyLocation[];
  /** From `--to`: the new audience, applied without prompting. */
  targetNames?: string[];
}): Promise<Environment[]> => {
  const allApps = await AppDiscoveryService.getAllApps();

  output.section("Current apps");
  const loaded = await loadEnvironments({ allApps, key, locations });

  for (const { audience, environment } of loaded) {
    output.log(`  ${environment}: ${[...audience].join(", ")}`);
  }

  const currentNames = new Set(loaded.flatMap(({ audience }) => [...audience]));

  const selectedApps = targetNames ? [] : await promptForApps(currentNames);

  const targets = targetNames
    ? validateAppNames({ allApps, names: targetNames })
    : new Set(selectedApps.map((app) => app.name));

  const plans = await mapSequentially(loaded, (environment) =>
    planTargets({ allApps, key, loaded: environment, targets })
  );

  const conflicts = plans.flatMap(({ result }) =>
    "conflict" in result ? [result.conflict] : []
  );

  if (conflicts.length > 0) {
    throw new Error(`Nothing changed. ${conflicts.join(" ")}`);
  }

  if (!targetNames) {
    await confirmOrExit(
      `Make ${key} visible to ${[...targets].join(", ")} in ${plans.length} environment(s)?`
    );
  }

  await applyPlans(plans);

  return plans.map(({ environment }) => environment);
};

/** Options of `env update <KEY>`; passing a key makes the command non-interactive. */
export interface UpdateFlags {
  /** Change who sees the key instead of its value; needs `--to`. */
  apps?: boolean;
  /** Required for production, which is otherwise only reachable through the prompts. */
  confirmProduction?: boolean;
  /** Each `--env`, possibly comma-separated. */
  env?: string[];
  /** Run `env sync` / `env sync-ssm` for real after writing; skipped otherwise. */
  push?: boolean;
  /** The one folder (`shared` or an app) whose copy is rewritten. */
  target?: string;
  /** With `--apps`: comma-separated app folder names that should see the key. */
  to?: string;
  value?: string;
  valueStdin?: boolean;
}

export interface UpdateByFlagsDependencies {
  authenticate: typeof authenticateForSops;
  collectKeyLocations: typeof collectKeyLocations;
  readValue?: () => Promise<string>;
  refreshLocalDecryptedFiles: typeof refreshLocalDecryptedFiles;
  rewriteLocation: typeof rewriteLocation;
  syncEnvironments: typeof syncEnvironments;
  updateApps: typeof updateApps;
}

const defaultUpdateByFlagsDependencies: UpdateByFlagsDependencies = {
  authenticate: authenticateForSops,
  collectKeyLocations,
  refreshLocalDecryptedFiles,
  rewriteLocation,
  syncEnvironments,
  updateApps,
};

const assertFlagsFitMode = (flags: UpdateFlags): void => {
  if (flags.apps) {
    if (!flags.to) {
      throw new Error("--apps needs --to <apps> with a KEY");
    }

    if (flags.target || flags.value !== undefined || flags.valueStdin) {
      throw new Error(
        "--apps takes --to, not --target, --value or --value-stdin"
      );
    }

    return;
  }

  if (flags.to) {
    throw new Error("--to only applies with --apps");
  }
};

const assertOneCopyPerEnvironment = ({
  key,
  locations,
}: {
  key: string;
  locations: KeyLocation[];
}): void => {
  for (const environment of ENVIRONMENTS) {
    const copies = locations.filter(
      (location) => location.environment === environment
    );

    if (copies.length > 1) {
      const found = copies.map(({ directory }) => `${directory}/`).join(", ");

      throw new Error(
        `${key} has copies in ${found} for ${environment}; pass --target <folder> to pick one`
      );
    }
  }
};

const parseList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const applyFlagUpdate = async ({
  dependencies,
  flags,
  key,
  locations,
  value,
}: {
  dependencies: UpdateByFlagsDependencies;
  flags: UpdateFlags;
  key: string;
  locations: KeyLocation[];
  /** Undefined in `--apps` mode, which keeps the value. */
  value: string | undefined;
}): Promise<Environment[]> => {
  if (value === undefined) {
    return await dependencies.updateApps({
      key,
      locations,
      targetNames: parseList(flags.to),
    });
  }

  assertOneCopyPerEnvironment({ key, locations });

  // sequential so console output stays readable and ordered
  await mapSequentially(locations, ({ directory, environment }) =>
    dependencies.rewriteLocation({ directory, environment, key, value })
  );

  return [...new Set(locations.map(({ environment }) => environment))];
};

/** Non-interactive `env update KEY`; resolves true when a requested sync failed. */
export const updateByFlags = async ({
  dependencies = defaultUpdateByFlagsDependencies,
  flags,
  key,
}: {
  dependencies?: UpdateByFlagsDependencies;
  flags: UpdateFlags;
  key: string;
}): Promise<boolean> => {
  const environments = parseEnvironments(flags.env);
  assertProductionConfirmed({
    environments,
    isConfirmed: flags.confirmProduction,
  });
  assertFlagsFitMode(flags);

  const value = flags.apps
    ? undefined
    : await resolveFlagValue({
        flags: { value: flags.value, valueStdin: flags.valueStdin },
        readValue: dependencies.readValue,
      });

  await dependencies.authenticate();

  const allLocations = await dependencies.collectKeyLocations(environments);

  const locations = selectLocations({
    environments,
    key,
    locations: allLocations.get(key) ?? [],
    target: flags.target,
  });

  const found = await applyFlagUpdate({
    dependencies,
    flags,
    key,
    locations,
    value,
  });

  await dependencies.refreshLocalDecryptedFiles(found);
  output.success(`${key} updated and re-encrypted.`);

  if (!flags.push) {
    output.info(
      "Not pushed. Run `env sync <environment>` / `env sync-ssm <environment>` when ready, or pass --push."
    );

    return false;
  }

  return await dependencies.syncEnvironments({
    dryRun: false,
    environments: found,
    shouldSyncSSM: true,
    shouldSyncVercel: true,
  });
};

export const updateCommand = new Command("update")
  .description(
    "Change the value of an existing environment variable, or with --apps which apps see it: an interactive wizard, or non-interactive when KEY is given"
  )
  .argument("[key]", "variable name; makes the command non-interactive")
  .option(
    "--apps",
    "Change which apps see the variable instead of its value: one app keeps it in that app's own folder, several share it from shared/ with a # @apps: tag (which also decides SSM via infra)"
  )
  .option(
    "--env <environment>",
    "environment to write; repeat or comma-separate",
    collectOption
  )
  .option("--value <value>", "the new value inline (non-secrets only)")
  .option("--value-stdin", "read the new value from stdin")
  .option(
    "--target <folder>",
    "the one copy to rewrite when the key lives in several folders (shared or an app)"
  )
  .option("--to <apps>", "with --apps: comma-separated apps that should see it")
  .option("--push", "run env sync / env sync-ssm after writing")
  .option("--confirm-production", "allow writing production without a prompt")
  .action(async (keyArgument: string | undefined, options: UpdateFlags) => {
    try {
      if (keyArgument) {
        const hasSyncFailed = await updateByFlags({
          flags: options,
          key: keyArgument,
        });

        process.exit(hasSyncFailed ? 1 : 0);
      }

      const { apps, ...flags } = options;

      if (Object.keys(flags).length > 0) {
        throw new Error(
          "Flags need a KEY: env update <KEY> --env … --value-stdin"
        );
      }

      const environments = await checkbox<Environment>({
        choices: ENVIRONMENTS.map((environment) => ({
          checked: false,
          name: environment,
          value: environment,
        })),
        message: "Which environments?",
        required: true,
      });

      await checkAndAuthenticateAWS();
      SopsService.validateSopsInstalled();

      output.section(`Reading ${environments.join(", ")}`);
      const allLocations = await collectKeyLocations(environments);

      if (allLocations.size === 0) {
        output.error(
          `No variables are defined in: ${environments.join(", ")}. Use \`env add\` to introduce one.`
        );
        process.exit(1);
      }

      const key = await promptForKey({
        locations: allLocations,
        message: "Which variable?",
      });

      const locations = allLocations.get(key) ?? [];

      printLocations(key, locations);

      const found = apps
        ? await updateApps({ key, locations })
        : await updateValues({ environments, key, locations });

      await refreshLocalDecryptedFiles(found);

      output.log("");
      output.success(`${key} updated and re-encrypted.`);

      const syncFailed = await syncAfterUpdate(found);
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
          error instanceof Error ? error.message : "Update variable failed"
        );
      }

      process.exit(1);
    }
  });
