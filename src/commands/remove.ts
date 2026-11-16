import { checkbox, confirm } from "@inquirer/prompts";
import { Command } from "commander";

import {
  getSsmKeys,
  getSsmParameterNames,
  isExternallyManagedKey,
} from "../config";
import { ENVIRONMENTS } from "../constants/environments";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { AppDiscoveryService } from "../services/app-discovery.service";
import { SopsService } from "../services/sops.service";
import { SSMService } from "../services/ssm.service";
import { VercelService } from "../services/vercel.service";
import type { AppConfig, Environment } from "../types/app-config.types";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import {
  assertProductionConfirmed,
  authenticateForSops,
  collectOption,
  parseEnvironments,
  selectLocations,
} from "../utils/non-interactive";
import { isExitPromptError } from "../utils/prompt-errors";
import { collectKeyLocations, promptForKey } from "../utils/variable-locations";
import { refreshLocalDecryptedFiles } from "./add";
import { INFRA_APP_NAME } from "./sync-ssm";
import {
  applyPlans,
  loadEnvironments,
  planTargets,
  variableAudience,
  writeChanges,
} from "./update";
import type { EnvironmentPlan, LoadedEnvironment } from "./update";

/**
 * A variable written by `env add` is preceded by its directives:
 *
 *   # @apps: api, app
 *   # SecureString
 *   KEY="value"
 *
 * Those describe this variable and nothing else, so they go with it. Left
 * behind they would sit above an unrelated variable and misdescribe it, which
 * is worse than clutter.
 */
const SCOPE_PREFIXES = ["# @apps:", "# @global"];
const TYPE_PREFIXES = ["# String", "# SecureString"];

const startsWithAny = (line: string, prefixes: string[]): boolean =>
  prefixes.some((prefix) => line.trim().startsWith(prefix));

/**
 * A `# @apps:` / `# @global` line scopes every variable below it up to the next
 * one, so it only belongs to the variable being removed when nothing else
 * follows in that block.
 */
const blockHasOtherVariables = ({
  index,
  key,
  lines,
}: {
  lines: string[];
  /** Position of the definition being removed. */
  index: number;
  key: string;
}): boolean => {
  for (const line of lines.slice(index + 1)) {
    const trimmed = line.trim();

    if (startsWithAny(trimmed, SCOPE_PREFIXES)) {
      return false;
    }

    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith(`${key}=`)) {
      return true;
    }
  }

  return false;
};

/**
 * Drops every line defining `key`, along with the directive lines immediately
 * above each one. Returns how many definitions went, so the caller can report
 * a file that unexpectedly held none.
 */
export const removeVariableLines = ({
  content,
  key,
}: {
  /** Decrypted env file text, split and rejoined on `\n`. */
  content: string;
  /** Variable name; matches only lines starting with `<key>=`. */
  key: string;
}) => {
  const prefix = `${key}=`;
  const lines = content.split("\n");
  const keep: string[] = [];
  let removed = 0;

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith(prefix)) {
      keep.push(line);
      continue;
    }

    removed += 1;

    // Walk back over this definition's own type line, then its scope line and
    // the blank line `env add` puts before it, so no gap is left behind. The
    // scope line stays while other variables in its block still depend on it.
    while (keep.length > 0 && startsWithAny(keep.at(-1) ?? "", TYPE_PREFIXES)) {
      keep.pop();
    }

    const isScopeLineMine =
      startsWithAny(keep.at(-1) ?? "", SCOPE_PREFIXES) &&
      !blockHasOtherVariables({ index, key, lines });

    if (isScopeLineMine) {
      keep.pop();
    }

    if (keep.length > 0 && keep.at(-1)?.trim() === "") {
      keep.pop();
    }
  }

  return { content: keep.join("\n"), removed };
};

/** What one environment's file changes took away. */
interface RemovalOutcome {
  /** Folder names that no longer see the key. */
  dropped: string[];
  environment: Environment;
  /** Nothing sees the key any more. */
  isRetired: boolean;
}

/**
 * Plans taking `removed` targets out of the key's audience in one
 * environment. Narrowing leaves it where the remaining targets belong (their
 * own file for one, shared/ with a tag for several); removing the last target
 * deletes every definition. Null when none of the removed targets saw it.
 */
export const planRemoval = async ({
  allApps,
  key,
  loaded,
  removed,
}: {
  allApps: AppConfig[];
  key: string;
  loaded: LoadedEnvironment;
  /** Folder names of the targets losing the key. */
  removed: Set<string>;
}): Promise<(EnvironmentPlan & RemovalOutcome) | null> => {
  const dropped = [...loaded.audience].filter((name) => removed.has(name));

  if (dropped.length === 0) {
    return null;
  }

  const targets = new Set(
    [...loaded.audience].filter((name) => !removed.has(name))
  );

  if (targets.size > 0) {
    const plan = await planTargets({ allApps, key, loaded, targets });

    return { ...plan, dropped, isRetired: false };
  }

  const changes = Object.fromEntries(
    [...loaded.files].map(([directory, { content }]) => [
      directory,
      removeVariableLines({ content, key }).content,
    ])
  );

  return {
    dropped,
    environment: loaded.environment,
    files: loaded.files,
    isRetired: true,
    result: { changes },
  };
};

/**
 * Vercel keeps a variable until something deletes it — `env sync` only adds and
 * updates — so a variable retired from the encrypted files lingers in every
 * project until this runs.
 */
interface VercelRemoval {
  /** Projects to remove the key from; every Vercel app when omitted. */
  apps?: AppConfig[];
  /** Report what would be removed from each project without deleting. */
  dryRun: boolean;
  /** Vercel environments (classic targets or custom) to remove the key from. */
  environments: Environment[];
  /** Variable name being retired. */
  key: string;
}

/**
 * Takes the already-discovered apps so the client is only created after
 * discovery — VercelService.create() may run an interactive `vercel login`.
 */
const removeFromVercelApps = async (
  apps: AppConfig[],
  { dryRun, environments, key }: VercelRemoval
): Promise<void> => {
  const vercel = await VercelService.create();

  // sequential per project so console output stays readable and ordered
  await mapSequentially(apps, async (app) => {
    const project = await VercelService.resolveProject(app);

    if (!project) {
      output.warning(`  ${app.name}: not linked to Vercel; skipping`);

      return;
    }

    vercel.useProject(project);

    // the client is stateful per initialized project, so these have to stay ordered
    await mapSequentially(environments, async (environment) => {
      const existing = await vercel.getEnvironmentVariables(environment);
      const match = existing.find((variable) => variable.key === key);

      if (!match?.id) {
        output.log(`  ${app.name}/${environment}: not present`);
      } else if (dryRun) {
        output.info(`  ${app.name}/${environment}: would remove ${key}`);
      } else {
        // Only this environment: the same variable can serve others the app still reads.
        const outcome = await vercel.removeFromEnvironment(match, environment);
        output.success(`  ${app.name}/${environment}: ${outcome} ${key}`);
      }
    });
  });
};

const removeFromVercel = async ({
  apps,
  ...removal
}: VercelRemoval): Promise<void> => {
  if (isExternallyManagedKey(removal.key)) {
    output.info(
      `  Skipped ${removal.key}: managed outside this CLI (externallyManagedKeys in env.config.json)`
    );

    return;
  }

  await removeFromVercelApps(
    apps ?? (await AppDiscoveryService.getVercelApps()),
    removal
  );
};

const removeFromSSM = async ({
  dryRun,
  environments,
  key,
}: {
  /** Report which parameters exist without deleting them. */
  dryRun: boolean;
  /** Each maps to its SSM paths via `getSsmParameterNames`. */
  environments: Environment[];
  /** Variable being retired; a missing parameter is reported, not an error. */
  key: string;
}): Promise<void> => {
  const names = environments.flatMap((environment) =>
    getSsmParameterNames({ environment, key })
  );

  // sequential so console output stays readable and ordered
  await mapSequentially(names, async (name) => {
    const result = await SSMService.deleteParameter({ dryRun, name });

    if (result.action === "deleted") {
      output.success(`  ${name}: ${dryRun ? "would delete" : "deleted"}`);
    } else {
      output.log(`  ${name}: not present`);
    }
  });
};

/** Only keys the sync knows about ever reached SSM. */
const isSyncedToSSM = (key: string): boolean => {
  const { optional, required } = getSsmKeys();

  return [...required, ...optional].some((name) => name === key);
};

/**
 * The remote copies to delete. A retired environment clears every Vercel app
 * and SSM; a narrowed one only the apps that lost the key, which would
 * otherwise keep reading it because `env sync` never deletes.
 */
export const planRemoteRemovals = ({
  allApps,
  key,
  outcomes,
}: {
  allApps: AppConfig[];
  key: string;
  outcomes: RemovalOutcome[];
}): {
  /** Environments whose `/<environment>/<key>` parameter goes. */
  ssmEnvironments: Environment[];
  /** One `removeFromVercel` call each. */
  vercel: Pick<VercelRemoval, "apps" | "environments">[];
} => {
  const retired = outcomes.flatMap(({ environment, isRetired }) =>
    isRetired ? [environment] : []
  );

  const narrowed = outcomes.flatMap(({ dropped, environment, isRetired }) => {
    const apps = allApps.filter(
      (app) => app.type === "vercel" && dropped.includes(app.name)
    );

    return isRetired || apps.length === 0
      ? []
      : [{ apps, environments: [environment] }];
  });

  const ssmEnvironments = outcomes.flatMap(
    ({ dropped, environment, isRetired }) =>
      isRetired || dropped.includes(INFRA_APP_NAME) ? [environment] : []
  );

  return {
    ssmEnvironments: isSyncedToSSM(key) ? ssmEnvironments : [],
    vercel: [
      ...(retired.length > 0 ? [{ environments: retired }] : []),
      ...narrowed,
    ],
  };
};

/** Options of `env remove <KEY>`; passing a key makes the command non-interactive. */
export interface RemoveFlags {
  /** Required for production, which is otherwise only reachable through the prompts. */
  confirmProduction?: boolean;
  /** Each `--env`, possibly comma-separated. */
  env?: string[];
  /** Delete from Vercel and SSM for real for every app that lost the key; skipped otherwise. */
  push?: boolean;
  /** Remove only this folder's copy (`shared` or an app); every copy when omitted. */
  target?: string;
}

export interface RemoveByFlagsDependencies {
  authenticate: typeof authenticateForSops;
  collectKeyLocations: typeof collectKeyLocations;
  getAllApps: typeof AppDiscoveryService.getAllApps;
  loadEnvironments: typeof loadEnvironments;
  refreshLocalDecryptedFiles: typeof refreshLocalDecryptedFiles;
  removeFromSSM: typeof removeFromSSM;
  removeFromVercel: typeof removeFromVercel;
  writeChanges: typeof writeChanges;
}

const removeRemotely = async ({
  dependencies,
  dryRun,
  key,
  removals: { ssmEnvironments, vercel },
}: {
  dependencies: Pick<
    RemoveByFlagsDependencies,
    "removeFromSSM" | "removeFromVercel"
  >;
  dryRun: boolean;
  key: string;
  removals: ReturnType<typeof planRemoteRemovals>;
}): Promise<void> => {
  if (vercel.length > 0) {
    output.section("Vercel");
    // sequential: the Vercel client is stateful per project
    await mapSequentially(vercel, (removal) =>
      dependencies.removeFromVercel({ ...removal, dryRun, key })
    );
  }

  if (ssmEnvironments.length > 0) {
    output.section("SSM");
    await dependencies.removeFromSSM({
      dryRun,
      environments: ssmEnvironments,
      key,
    });
  }
};

const defaultRemoveByFlagsDependencies: RemoveByFlagsDependencies = {
  authenticate: authenticateForSops,
  collectKeyLocations,
  getAllApps: () => AppDiscoveryService.getAllApps(),
  loadEnvironments,
  refreshLocalDecryptedFiles,
  removeFromSSM,
  removeFromVercel,
  writeChanges,
};

/** Non-interactive `env remove KEY`. */
export const removeByFlags = async ({
  dependencies = defaultRemoveByFlagsDependencies,
  flags,
  key,
}: {
  dependencies?: RemoveByFlagsDependencies;
  flags: RemoveFlags;
  key: string;
}): Promise<void> => {
  const environments = parseEnvironments(flags.env);
  assertProductionConfirmed({
    environments,
    isConfirmed: flags.confirmProduction,
  });

  await dependencies.authenticate();

  const allLocations = await dependencies.collectKeyLocations(environments);
  const locations = allLocations.get(key) ?? [];

  selectLocations({ environments, key, locations, target: flags.target });

  const allApps = await dependencies.getAllApps();

  const loaded = await dependencies.loadEnvironments({
    allApps,
    key,
    locations,
  });

  // sequential so console output stays readable and ordered
  const outcomes = await mapSequentially(
    loaded,
    async ({ audience, environment, files }): Promise<RemovalOutcome> => {
      const directories = flags.target ? [flags.target] : [...files.keys()];

      const changes = Object.fromEntries(
        directories.map((directory) => [
          directory,
          removeVariableLines({
            content: files.get(directory)?.content ?? "",
            key,
          }).content,
        ])
      );

      await dependencies.writeChanges({ changes, environment, files });

      const remaining = variableAudience({
        allApps,
        contents: Object.fromEntries(
          [...files].map(([directory, { content }]) => [
            directory,
            changes[directory] ?? content,
          ])
        ),
        key,
      });

      return {
        dropped: [...audience].filter((name) => !remaining.has(name)),
        environment,
        isRetired: directories.length === files.size,
      };
    }
  );

  await dependencies.refreshLocalDecryptedFiles(environments);
  output.success(`${key} removed from the encrypted files.`);

  const removals = planRemoteRemovals({ allApps, key, outcomes });

  if (removals.vercel.length === 0 && removals.ssmEnvironments.length === 0) {
    output.info(
      `${key} is still defined for the same apps in ${environments.join(", ")}, so its Vercel and SSM values stay.`
    );

    return;
  }

  if (!flags.push) {
    output.info(
      `Not deleted remotely. Re-run with --push to delete ${key} from Vercel and SSM where no app reads it any more.`
    );

    return;
  }

  await removeRemotely({ dependencies, dryRun: false, key, removals });
};

export const removeCommand = new Command("remove")
  .description(
    "Retire an environment variable: encrypted files, Vercel and SSM; an interactive wizard, or non-interactive when KEY is given"
  )
  .argument("[key]", "variable name; makes the command non-interactive")
  .option(
    "--env <environment>",
    "environment to remove from; repeat or comma-separate",
    collectOption
  )
  .option(
    "--target <folder>",
    "remove only this folder's copy (shared or an app); every copy when omitted"
  )
  .option(
    "--push",
    "also delete from Vercel and SSM for every app that no longer sees it"
  )
  .option("--confirm-production", "allow writing production without a prompt")
  .action(async (keyArgument: string | undefined, flags: RemoveFlags) => {
    try {
      if (keyArgument) {
        await removeByFlags({ flags, key: keyArgument });
        process.exit(0);
      }

      if (Object.keys(flags).length > 0) {
        throw new Error("Flags need a KEY: env remove <KEY> --env …");
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
          `No variables are defined in: ${environments.join(", ")}.`
        );
        process.exit(1);
      }

      const key = await promptForKey({
        locations: allLocations,
        message: "Which variable should be retired?",
      });

      const locations = allLocations.get(key) ?? [];

      const allApps = await AppDiscoveryService.getAllApps();
      const loaded = await loadEnvironments({ allApps, key, locations });
      output.section("Currently seen by");

      for (const { audience, environment } of loaded) {
        output.log(`  ${environment}: ${[...audience].join(", ")}`);
      }

      const seenBy = [
        ...new Set(loaded.flatMap(({ audience }) => [...audience])),
      ].toSorted();

      const removed = new Set(
        await checkbox<string>({
          choices: seenBy.map((name) => ({
            checked: false,
            name,
            value: name,
          })),
          message: `Remove ${key} from which apps?`,
          required: true,
        })
      );

      const candidates = await mapSequentially(loaded, (environment) =>
        planRemoval({ allApps, key, loaded: environment, removed })
      );

      const plans = candidates.filter((plan) => plan !== null);

      const conflicts = plans.flatMap(({ result }) =>
        "conflict" in result ? [result.conflict] : []
      );

      if (conflicts.length > 0) {
        throw new Error(`Nothing changed. ${conflicts.join(" ")}`);
      }

      output.warning(
        "  This deletes the variable, not just its value. Anything still reading it will fail."
      );

      const proceed = await confirm({
        default: false,
        message: `Remove ${key} from ${[...removed].join(", ")} in ${plans.length} environment(s)?`,
      });

      if (!proceed) {
        output.info("Cancelled.");
        process.exit(0);
      }

      await applyPlans(plans);

      const touched = plans.map(({ environment }) => environment);
      await refreshLocalDecryptedFiles(touched);

      output.log("");
      output.success(`${key} removed from the encrypted files.`);

      const removals = planRemoteRemovals({ allApps, key, outcomes: plans });

      if (
        removals.vercel.length === 0 &&
        removals.ssmEnvironments.length === 0
      ) {
        output.info(
          `None of the removed apps reads ${key} from Vercel or SSM in ${touched.join(", ")}, so nothing is deleted remotely.`
        );
        process.exit(0);
      }

      const dryRun = await confirm({
        default: true,
        message: "Dry run the remote cleanup first?",
      });

      const isVercelConfirmed =
        removals.vercel.length > 0 &&
        (await confirm({
          default: false,
          message: "Also delete it from Vercel?",
        }));

      // Only keys the sync knows about ever reached SSM (planRemoteRemovals
      // leaves the rest out), so offering them would just print "not present".
      const isSSMConfirmed =
        removals.ssmEnvironments.length > 0 &&
        (await confirm({
          default: false,
          message: "Also delete it from AWS SSM?",
        }));

      await removeRemotely({
        dependencies: { removeFromSSM, removeFromVercel },
        dryRun,
        key,
        removals: {
          ssmEnvironments: isSSMConfirmed ? removals.ssmEnvironments : [],
          vercel: isVercelConfirmed ? removals.vercel : [],
        },
      });

      if (dryRun) {
        output.info(
          "Dry run only — nothing was deleted remotely. Re-run and answer no to the dry run to apply."
        );
      }

      process.exit(0);
    } catch (error) {
      if (isExitPromptError(error)) {
        output.info("\nCancelled.");
        process.exit(0);
      }

      if (error instanceof AWSCredentialsError) {
        outputAWSCredentialsError(error);
      } else {
        output.error(
          error instanceof Error ? error.message : "Remove variable failed"
        );
      }

      process.exit(1);
    }
  });
