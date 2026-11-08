import path from "node:path";

import { Command } from "commander";

import {
  buildSsmPath,
  getAwsProfile,
  getSsmKeys,
  hasSsmConfig,
} from "../config";
import { ENVIRONMENTS } from "../constants/environments";
import { getEnvDir } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import {
  AWSCredentialsError,
  checkAndAuthenticateAWS,
} from "../lib/aws-credentials";
import { EnvFilterService } from "../services/env-filter.service";
import { EnvMergeService } from "../services/env-merge.service";
import { SopsService } from "../services/sops.service";
import { SSMService } from "../services/ssm.service";
import type { SSMParameterType } from "../services/ssm.service";
import type { Environment } from "../types/app-config.types";
import { clearAWSCredentialEnvVars } from "../utils/aws-credential-env";
import { outputAWSCredentialsError } from "../utils/aws-credentials-guidance";
import { output } from "../utils/cli-output";
import {
  getEnvFileName,
  parseEnvContent,
  parseSSMTypeAnnotations,
} from "../utils/env-parser";
import { FileOperations } from "../utils/file-operations";

const SUPPORTED_ENVIRONMENTS: Environment[] = ENVIRONMENTS;

/** The `# @apps:` name that scopes a shared/ variable into SSM. */
export const INFRA_APP_NAME = "infra";

export const syncSSMCommandDependencies = {
  checkAndAuthenticateAWS,
  clearAWSCredentialEnvVars,
  decrypt: SopsService.decrypt,
  deleteParameter: SSMService.deleteParameter,
  exit: (code: number): never => process.exit(code),
  fileExists: FileOperations.fileExists,
  filterForApp: EnvFilterService.filterForAppWithFormatting,
  mergeFormatted: EnvMergeService.mergeFormatted,
  parseEnvContent,
  parseSSMTypeAnnotations,
  putParameter: SSMService.putParameter,
  resetSSMClient: SSMService.resetClient,
  validateSopsInstalled: (): void => {
    SopsService.validateSopsInstalled();
  },
};

/** Per-environment tally of SSM parameter outcomes, mutated during a sync. */
interface SyncSummary {
  /** Parameters `PutParameter` created (or would create, in dry-run). */
  created: number;
  /** Absent optional parameters removed under `--delete-absent-optional`. */
  deleted: number;
  /** Put/delete calls that threw; any non-zero makes the command exit 1. */
  failed: number;
  /** Parameters already matching type and value, or already absent. */
  skipped: number;
  /** Existing parameters overwritten with a new value or type. */
  updated: number;
}

/** Union of put and delete outcomes from `SSMService`, mapped onto `SyncSummary`. */
type ParameterAction = "created" | "deleted" | "updated" | "skipped";

const UNKNOWN_ERROR = "Unknown error";

const isSupportedEnvironment = (value: string): value is Environment =>
  SUPPORTED_ENVIRONMENTS.some((environment) => environment === value);

const resolveEnvironments = (environmentArg: string): Environment[] => {
  if (environmentArg === "all") {
    return SUPPORTED_ENVIRONMENTS;
  }

  if (!isSupportedEnvironment(environmentArg)) {
    throw new Error(
      `Invalid environment: ${environmentArg}. Must be one of: production, preview, development, all`
    );
  }

  return [environmentArg];
};

const decryptEnvFile = async ({
  environment,
  scope,
}: {
  /** Selects `.env.<environment>.enc`; a missing file decrypts to "". */
  environment: Environment;
  /** Folder under `env/`; infra values override shared on merge. */
  scope: "infra" | "shared";
}): Promise<string> => {
  const envFilePath = path.join(
    getEnvDir(),
    scope,
    `${getEnvFileName(environment)}.enc`
  );

  if (!(await syncSSMCommandDependencies.fileExists(envFilePath))) {
    output.warning(`  Missing ${scope} encrypted file for ${environment}`);

    return "";
  }

  const decrypted = await syncSSMCommandDependencies.decrypt(envFilePath);
  output.success(`  Decrypted ${scope} env for ${environment}`);

  return decrypted;
};

const redactedValue = ({
  type,
  value,
}: {
  /** `SecureString` values are masked; `String` values print as-is. */
  type: SSMParameterType;
  /** The value about to be logged. */
  value: string;
}): string => {
  if (type === "SecureString") {
    return "[REDACTED]";
  }

  return value;
};

const validateRequiredParameters = ({
  environment,
  mergedVariables,
  ssmTypeAnnotations,
}: {
  /** Named in the thrown error so the failing environment is obvious. */
  environment: Environment;
  /** infra-scoped shared + infra values; each `REQUIRED_SSM_PARAMETER_KEYS` entry must be non-empty. */
  mergedVariables: Record<string, string>;
  /** Each required key also needs a `# String` / `# SecureString` header. */
  ssmTypeAnnotations: Map<string, SSMParameterType>;
}): void => {
  const missingValues: string[] = [];
  const missingAnnotations: string[] = [];

  for (const key of getSsmKeys().required) {
    if (!mergedVariables[key]) {
      missingValues.push(key);
    }

    if (!ssmTypeAnnotations.has(key)) {
      missingAnnotations.push(key);
    }
  }

  if (missingValues.length > 0) {
    throw new Error(
      `Missing required variables for ${environment}: ${missingValues.join(", ")}. Add them in env/infra, or in env/shared under a \`# @apps:\` tag that lists infra.`
    );
  }

  if (missingAnnotations.length > 0) {
    throw new Error(
      `Missing SSM type annotations (# String or # SecureString) for ${environment}: ${missingAnnotations.join(", ")}. Add type comment headers in env/infra, or in env/shared under a \`# @apps:\` tag that lists infra.`
    );
  }
};

const incrementSummaryForAction = ({
  action,
  summary,
}: {
  /** Outcome reported by `SSMService`'s put or delete. */
  action: ParameterAction;
  /** Tally whose matching counter is incremented in place. */
  summary: SyncSummary;
}): void => {
  if (action === "created") {
    summary.created += 1;

    return;
  }

  if (action === "updated") {
    summary.updated += 1;

    return;
  }

  if (action === "deleted") {
    summary.deleted += 1;

    return;
  }

  summary.skipped += 1;
};

const deleteMissingOptionalParameter = async ({
  dryRun,
  parameterName,
  summary,
}: {
  /** Report the deletion without calling SSM `DeleteParameter`. */
  dryRun: boolean;
  /** Full `/<environment>/<key>` path from `buildSsmPath`. */
  parameterName: string;
  /** Tally updated with the outcome; a thrown delete counts as failed. */
  summary: SyncSummary;
}): Promise<void> => {
  try {
    const result = await syncSSMCommandDependencies.deleteParameter({
      dryRun,
      name: parameterName,
    });

    incrementSummaryForAction({ action: result.action, summary });

    if (result.action === "skipped") {
      output.info(
        `  Skipped ${parameterName} because it does not exist in SSM`
      );

      return;
    }

    output.success(
      `${dryRun ? "  Would delete" : "  Deleted"} ${parameterName}`
    );
  } catch (error) {
    summary.failed += 1;
    output.error(
      `  Failed to delete ${parameterName}\n${error instanceof Error ? error.message : UNKNOWN_ERROR}`
    );
  }
};

/** State shared while reconciling optional SSM keys that have no local value. */
interface OptionalParameterContext {
  /** `--delete-absent-optional`: delete the remote parameter instead of preserving it. */
  deleteAbsentOptional: boolean;
  /** Log the deletions without calling SSM. */
  dryRun: boolean;
  /** Environment whose `/${environment}/` SSM namespace is being synced. */
  environment: Environment;
  /** Variables merged from the decrypted env files for this environment. */
  mergedVariables: Record<string, string>;
  /** Per-key `# String` / `# SecureString` header annotations from the env files. */
  ssmTypeAnnotations: Map<string, SSMParameterType>;
  /** Running tally of created, updated, deleted, skipped and failed parameters. */
  summary: SyncSummary;
}

const handleMissingOptionalParameter = async ({
  context: {
    deleteAbsentOptional,
    dryRun,
    environment,
    mergedVariables,
    ssmTypeAnnotations,
    summary,
  },
  key,
}: {
  /** The environment's merged values, annotations, flags and running tally. */
  context: OptionalParameterContext;
  /** One of `ssm.optional`; a no-op when it has a value and type. */
  key: string;
}): Promise<void> => {
  const hasAnnotation = ssmTypeAnnotations.has(key);
  const hasValue = Boolean(mergedVariables[key]);
  const hasLocalEntry = key in mergedVariables;

  if (hasAnnotation && hasValue) {
    return;
  }

  if (hasLocalEntry && !hasAnnotation) {
    output.warning(
      `  Optional variable ${key} is present in local env files but missing SSM type annotation; skipping sync for ${key}. Add a type comment header (# String or # SecureString) in env/infra, or in env/shared under a \`# @apps:\` tag that lists infra.`
    );

    return;
  }

  const parameterName = buildSsmPath({ environment, key });

  if (!deleteAbsentOptional) {
    output.warning(
      `  Optional variable ${key} is absent from the infra-scoped env files; preserving existing remote value at ${parameterName}. Re-run with --delete-absent-optional to remove it from SSM.`
    );

    return;
  }

  await deleteMissingOptionalParameter({
    dryRun,
    parameterName,
    summary,
  });
};

const logMissingOptionalParameters = async (
  context: OptionalParameterContext
): Promise<void> => {
  // sequential to avoid AWS SSM rate limits during bulk deletes
  await mapSequentially(getSsmKeys().optional, (key) =>
    handleMissingOptionalParameter({ context, key })
  );
};

/** `SSMService.putParameter` outcomes, used to pick the log verb. */
type PutParameterAction = "created" | "updated" | "skipped";

const getActionLabel = ({
  action,
  dryRun,
}: {
  /** What `putParameter` did (or would do) to the parameter. */
  action: PutParameterAction;
  /** Switches created/updated to "Would create"/"Would update". */
  dryRun: boolean;
}): string => {
  if (action === "created") {
    return dryRun ? "Would create" : "Created";
  }

  if (action === "updated") {
    return dryRun ? "Would update" : "Updated";
  }

  return "Skipped";
};

const syncParameter = async ({
  dryRun,
  environment,
  key,
  summary,
  type,
  value,
}: {
  /** Report the create/update without calling SSM `PutParameter`. */
  dryRun: boolean;
  /** SSM namespace the parameter is written under, `/<environment>/`. */
  environment: Environment;
  /** Known `ssm` config key; the parameter's last path segment. */
  key: string;
  /** Tally updated with the outcome; a thrown put counts as failed. */
  summary: SyncSummary;
  /** SSM parameter type from the env file's annotation; `SecureString` is redacted in logs. */
  type: SSMParameterType;
  /** Non-empty merged value from the decrypted env files. */
  value: string;
}): Promise<void> => {
  const parameterName = buildSsmPath({ environment, key });

  try {
    const result = await syncSSMCommandDependencies.putParameter({
      dryRun,
      name: parameterName,
      type,
      value,
    });

    incrementSummaryForAction({ action: result.action, summary });

    const actionLabel = getActionLabel({
      action: result.action,
      dryRun,
    });

    output.success(`  ${actionLabel} ${parameterName}`);
    output.log(`    Type: ${type}`);
    output.log(`    Value: ${redactedValue({ type, value })}`);
  } catch (error) {
    summary.failed += 1;
    output.error(
      `  Failed to sync ${parameterName}\n${error instanceof Error ? error.message : UNKNOWN_ERROR}`
    );
  }
};

const syncAnnotatedParameter = async ({
  dryRun,
  environment,
  key,
  mergedVariables,
  summary,
  type,
}: {
  /** Forwarded to `syncParameter`: preview the write without making it. */
  dryRun: boolean;
  /** SSM namespace the parameter is written under, `/<environment>/`. */
  environment: Environment;
  /** Annotated env var; skipped with a warning unless it is in `ssm.required` or `ssm.optional`. */
  key: string;
  /** infra-scoped shared + infra values; an empty value skips the key silently. */
  mergedVariables: Record<string, string>;
  /** Tally shared across the environment's parameters. */
  summary: SyncSummary;
  /** SSM parameter type read from the key's annotation header. */
  type: SSMParameterType;
}): Promise<void> => {
  const { optional, required } = getSsmKeys();
  const parameterKey = [...required, ...optional].find(
    (candidate) => candidate === key
  );

  if (!parameterKey) {
    output.warning(`  Skipping unknown parameter key: ${key}`);

    return;
  }

  const value = mergedVariables[key];

  if (!value) {
    return;
  }

  await syncParameter({
    dryRun,
    environment,
    key: parameterKey,
    summary,
    type,
    value,
  });
};

const authenticateForEnvironment = async (
  environment: Environment
): Promise<void> => {
  const profile = getAwsProfile(environment);
  output.log(`  Assuming AWS profile: ${profile}`);
  process.env.AWS_PROFILE = profile;
  syncSSMCommandDependencies.clearAWSCredentialEnvVars();
  await syncSSMCommandDependencies.checkAndAuthenticateAWS({
    allowProduction: true,
  });
  syncSSMCommandDependencies.resetSSMClient();
};

const syncEnvironment = async ({
  deleteAbsentOptional,
  dryRun,
  environment,
}: {
  /** Picks the AWS profile, the env files, and the `/<environment>/` namespace. */
  environment: Environment;
  /** Delete optional parameters absent locally instead of preserving them. */
  deleteAbsentOptional: boolean;
  /** Report every put/delete without calling SSM. */
  dryRun: boolean;
}): Promise<SyncSummary> => {
  output.section(`Syncing to SSM: ${environment}`);

  await authenticateForEnvironment(environment);

  // One sops run at a time: concurrent decrypts flood KMS and interleave output.
  const [sharedContent, infraContent] = await mapSequentially(
    ["shared", "infra"] as const,
    (scope) => decryptEnvFile({ environment, scope })
  );

  // SSM serves apps/infra, so shared/ is scoped to it by `# @apps:` exactly as
  // `env sync` and `env decrypt` scope it per app; infra/ is infra's own and
  // wins on conflict. Annotations are read from the unfiltered text with the
  // same scope: filtering keeps the comment lines of dropped variables, so a
  // dropped key's `# SecureString` would otherwise attach to the next kept one.
  const infraSharedContent = syncSSMCommandDependencies.filterForApp(
    sharedContent,
    INFRA_APP_NAME
  );

  const ssmTypeAnnotations = new Map([
    ...syncSSMCommandDependencies.parseSSMTypeAnnotations(
      sharedContent,
      INFRA_APP_NAME
    ),
    ...syncSSMCommandDependencies.parseSSMTypeAnnotations(infraContent),
  ]);

  const mergedContent = syncSSMCommandDependencies.mergeFormatted(
    infraSharedContent,
    infraContent
  );

  const mergedVariables =
    syncSSMCommandDependencies.parseEnvContent(mergedContent);

  const summary: SyncSummary = {
    created: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
    updated: 0,
  };

  validateRequiredParameters({
    environment,
    mergedVariables,
    ssmTypeAnnotations,
  });

  await logMissingOptionalParameters({
    deleteAbsentOptional,
    dryRun,
    environment,
    mergedVariables,
    ssmTypeAnnotations,
    summary,
  });

  // sequential to avoid AWS SSM rate limits during bulk parameter sync
  await mapSequentially(ssmTypeAnnotations, ([key, type]) =>
    syncAnnotatedParameter({
      dryRun,
      environment,
      key,
      mergedVariables,
      summary,
      type,
    })
  );

  output.log("");
  output.log(`Created: ${summary.created}`);
  output.log(`Deleted: ${summary.deleted}`);
  output.log(`Updated: ${summary.updated}`);
  output.log(`Skipped: ${summary.skipped}`);

  if (summary.failed > 0) {
    output.error(`Failed: ${summary.failed}`);
  }

  return summary;
};

/**
 * Runs the SSM sync and returns whether it failed, rather than exiting the
 * process directly — callable from the `add` wizard (which still has more
 * work to do afterward), not just the CLI action below.
 */
export const handleSyncSSMCommand = async (
  environmentArg: string,
  options: {
    /** Delete optional SSM parameters missing from the env files; defaults off. */
    deleteAbsentOptional?: boolean;
    /** Report the SSM writes without making them; defaults off. */
    dryRun?: boolean;
  }
): Promise<boolean> => {
  const deleteAbsentOptional = options.deleteAbsentOptional ?? false;
  const dryRun = options.dryRun ?? false;

  if (!hasSsmConfig()) {
    output.info(
      "No SSM parameters configured: add an ssm section to env.config.json to sync to AWS SSM."
    );

    return false;
  }

  const environments = resolveEnvironments(environmentArg);

  syncSSMCommandDependencies.validateSopsInstalled();

  if (dryRun) {
    output.warning("DRY RUN MODE - No changes will be made\n");
  }

  // must stay sequential — authenticateForEnvironment mutates process.env.AWS_PROFILE, a shared global that later calls in this iteration depend on
  const failures = await mapSequentially(environments, async (environment) => {
    try {
      const summary = await syncEnvironment({
        deleteAbsentOptional,
        dryRun,
        environment,
      });

      return summary.failed;
    } catch (error) {
      if (error instanceof AWSCredentialsError) {
        outputAWSCredentialsError(error);

        return 1;
      }

      output.error(
        `SSM sync failed for ${environment}\n${error instanceof Error ? error.message : UNKNOWN_ERROR}`
      );

      return 1;
    }
  });

  const totalFailed = failures.reduce((sum, failed) => sum + failed, 0);

  output.log("");

  if (totalFailed > 0) {
    output.error("SSM sync completed with errors");

    return true;
  }

  output.success("SSM sync completed successfully");

  return false;
};

export const syncSSMCommand = new Command("sync-ssm")
  .description("Sync selected environment variables to AWS SSM Parameter Store")
  .argument(
    "[environment]",
    "Environment to sync (production, staging, preview, development, all)",
    "all"
  )
  .option(
    "--delete-absent-optional",
    "Delete optional SSM parameters when they are absent from merged env files"
  )
  .option("--dry-run", "Show what would be synced without making changes")
  .action(
    async (
      environmentArg: string,
      options: {
        /** Set by `--delete-absent-optional`: remove optional params absent locally. */
        deleteAbsentOptional?: boolean;
        /** Set by `--dry-run`: print the SSM writes instead of making them. */
        dryRun?: boolean;
      }
    ) => {
      try {
        const failed = await handleSyncSSMCommand(environmentArg, options);
        syncSSMCommandDependencies.exit(failed ? 1 : 0);
      } catch (error) {
        if (error instanceof AWSCredentialsError) {
          outputAWSCredentialsError(error);
        } else {
          output.error(
            error instanceof Error ? error.message : "SSM sync failed"
          );
        }

        syncSSMCommandDependencies.exit(1);
      }
    }
  );
