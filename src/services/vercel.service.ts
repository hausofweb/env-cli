import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { Vercel } from "@vercel/sdk";
import {
  filterProjectEnvsResponseBody1FromJSON,
  filterProjectEnvsResponseBody2FromJSON,
  filterProjectEnvsResponseBody3FromJSON,
} from "@vercel/sdk/models/filterprojectenvsop";
import { z } from "zod";

import { isExternallyManagedKey } from "../config";
import { getProjectRoot } from "../constants/paths";
import { mapSequentially } from "../lib/async";
import type { AppConfig, Environment } from "../types/app-config.types";
import type { EnvVariable } from "../types/env-file.types";
import { VercelError } from "../types/vercel-error";
import type { VercelSyncResult } from "../types/vercel.types";
import { output } from "../utils/cli-output";
import { FileOperations } from "../utils/file-operations";
import { resolvePackageBin } from "../utils/package-bin";

/**
 * Service for Vercel API operations using the official SDK
 */
/**
 * Vercel has no native "staging" target — production/preview/development are
 * the only classic targets. Any other Environment value is assumed to be the
 * slug of a Vercel Custom Environment and is scoped via customEnvironmentIds
 * instead of target.
 */
type ClassicTarget = "production" | "preview" | "development";

const CLASSIC_TARGETS: readonly ClassicTarget[] = [
  "production",
  "preview",
  "development",
];

const isClassicTarget = (environment: string): environment is ClassicTarget =>
  CLASSIC_TARGETS.some((target) => target === environment);

/** How a Vercel env var is scoped to one of our environments. */
type EnvironmentScope =
  | {
      /** Scoped through Vercel's built-in `target` array. */
      kind: "target";
      /** Built-in Vercel target the environment maps to by name. */
      target: ClassicTarget;
    }
  | {
      /** Scoped through `customEnvironmentIds` (e.g. staging). */
      kind: "custom";
      /** Vercel Custom Environment id resolved from the environment slug. */
      customEnvironmentId: string;
    };

/**
 * A variable's live state in Vercel also carries its comment (where the
 * synced-value hash lives, see SYNC_HASH_PREFIX below) and its current type,
 * so a sync can detect a type that needs correcting even when the value
 * hasn't changed.
 */
export interface VercelExistingVariable extends EnvVariable {
  /** Vercel env var comment; holds the `SYNC_HASH_PREFIX` value hash. */
  comment?: string;
  /**
   * One Vercel variable can span several targets and custom environments, so
   * an edit or removal by ID has to account for all of them.
   */
  customEnvironmentIds: string[];
  /** Set on a deliberate per-branch preview override. */
  gitBranch?: string;
  /**
   * Owned by an integration (`configurationId`, `contentHint`, edge config,
   * a Flags secret's `securityIssues`) or by Vercel itself (`system`) rather
   * than by this tool, so never pruned.
   */
  isManaged: boolean;
  /** Vercel's classic targets the variable is scoped to. */
  targets: string[];
  /** Vercel's `type`, or undefined when the API returned one we don't know. */
  vercelType?: VercelVariableType;
}

/** One env var as Vercel's list endpoint returns it. */
interface RawVercelEnv {
  /** Carries the `sops-sync:sha256:` hash written by the last sync. */
  comment?: string;
  /** Set when an integration owns the variable. */
  configurationId?: string | null;
  /** Set when the value references another Vercel resource. */
  contentHint?: unknown;
  /** IDs of the custom environments (e.g. staging) the variable is scoped to. */
  customEnvironmentIds?: unknown;
  /** Set when an Edge Config integration owns the variable. */
  edgeConfigId?: string | null;
  /** Set when an Edge Config token backs the variable. */
  edgeConfigTokenId?: string | null;
  /** Set on a per-branch preview override. */
  gitBranch?: string;
  /** Vercel env var ID used for edits and removal; entries without one are dropped. */
  id?: string;
  /** Variable name; entries without one are dropped. */
  key?: string;
  /** Vercel's findings on the variable; `flags-secret-needs-split` marks a Vercel Flags secret. */
  securityIssues?: string[];
  /** True for variables Vercel itself provides. */
  system?: boolean;
  /** Vercel's classic targets (`production`/`preview`/`development`); parsed with zod. */
  target?: unknown;
  /** Vercel variable type; kept only when it is a known `VercelVariableType`. */
  type?: unknown;
  /** As listed by Vercel — never decrypted, so only a fallback for comparison. */
  value?: string;
}

/** The project a VercelService instance reads and writes variables on. */
export interface VercelProjectConfig {
  /** Team (org) ID; omitted for a personal-account project. */
  orgId?: string;
  /** Vercel project ID (or name). */
  projectId: string;
}

/** Vercel env var `type`; `sensitive` values can never be decrypted again. */
export type VercelVariableType = "encrypted" | "plain" | "sensitive";

/**
 * Maps a source annotation ("# String" / "# SecureString") to the Vercel
 * variable type to create/update it with.
 *
 * Vercel only allows "sensitive" (a value that can never be decrypted again,
 * by anyone) for the production/preview/custom-environment targets — the
 * dashboard disables the option outright when Development is selected, and
 * the API rejects it the same way. SecureString values targeting development
 * fall back to "encrypted" (the prior default for every variable), which is
 * still encrypted at rest but can be revealed by a permitted user.
 *
 * A variable with no annotation yet (not every file has been migrated to the
 * String/SecureString convention) keeps the "encrypted" default so
 * partially-annotated files don't change behavior.
 */
export const resolveVercelType = (
  annotationType: EnvVariable["type"],
  environment: Environment
): VercelVariableType => {
  if (annotationType === "SecureString") {
    return environment === "development" ? "encrypted" : "sensitive";
  }

  if (annotationType === "String") {
    return "plain";
  }

  return "encrypted";
};

const sdkBadRequestSchema = z.object({
  body: z.string(),
  name: z.literal("VercelError"),
  statusCode: z.literal(400),
});

/**
 * True when a create/update call was rejected specifically because
 * "sensitive" isn't supported for this target — as opposed to some other,
 * real failure. Detected by message content rather than a specific error
 * class, since the SDK surfaces this as a generic 400.
 */
const isSensitiveNotSupportedError = (error: Error): boolean => {
  const parsed = sdkBadRequestSchema.safeParse(error);

  return parsed.success && parsed.data.body.toLowerCase().includes("sensitive");
};

/** A target list from the API: string arrays as-is, a non-empty string as a one-item list, anything else empty. */
const targetsSchema = z.union([
  z.array(z.string()),
  z
    .string()
    .min(1)
    .transform((target) => [target]),
  z.unknown().transform((): string[] => []),
]);

const VERCEL_VARIABLE_TYPES: readonly VercelVariableType[] = [
  "encrypted",
  "plain",
  "sensitive",
];

const isVercelVariableType = (value: unknown): value is VercelVariableType =>
  VERCEL_VARIABLE_TYPES.some((type) => type === value);

/**
 * Whether converting an existing variable's type requires delete-then-
 * recreate rather than an in-place edit (see applyVariableUpdate). Returns
 * `false` when the current type is unknown (e.g. Vercel returned a `type`
 * this tool doesn't recognize) — we can't tell whether it's already
 * "sensitive", so a destructive delete is never triggered on a guess; an
 * in-place update is attempted instead, which Vercel itself will reject if
 * it's genuinely unsupported.
 */
export const needsTypeRecreate = (
  currentType: VercelVariableType | undefined,
  resolvedType: VercelVariableType
): boolean =>
  currentType !== undefined &&
  (currentType === "sensitive") !== (resolvedType === "sensitive");

/**
 * Vercel's list/filter endpoint never returns decrypted values, and
 * "sensitive"-type variables can never be decrypted via any endpoint, by
 * design — so comparing actual values isn't possible in general. Instead,
 * each synced variable's comment stores a hash of the value it was synced
 * with; the next sync compares against that hash instead of the value
 * itself. This also means only one API call per environment is needed
 * (the list call) rather than one extra decrypt call per existing variable.
 *
 * Trade-off: this can only detect drift between the local SOPS source and
 * what this tool last pushed. It cannot detect a value that was changed
 * directly in the Vercel dashboard after the fact, since the live value is
 * never read back.
 */
export const SYNC_HASH_PREFIX = "sops-sync:sha256:";

export const hashValue = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const buildSyncComment = (value: string): string =>
  `${SYNC_HASH_PREFIX}${hashValue(value)}`;

export const extractSyncedHash = (
  comment: string | undefined
): string | null => {
  if (!comment?.startsWith(SYNC_HASH_PREFIX)) {
    return null;
  }

  return comment.slice(SYNC_HASH_PREFIX.length);
};

/**
 * Owned by an integration or by Vercel itself rather than by this tool.
 */
const isManagedEnv = (env: RawVercelEnv): boolean =>
  env.system === true ||
  env.securityIssues?.includes("flags-secret-needs-split") === true ||
  [
    env.configurationId,
    env.contentHint,
    env.edgeConfigId,
    env.edgeConfigTokenId,
  ].some(Boolean);

/**
 * Check whether an env variable is scoped to the given target/custom
 * environment and extract it
 */
const extractIfMatches = (
  env: RawVercelEnv,
  scope: EnvironmentScope
): VercelExistingVariable | null => {
  const targets = targetsSchema.parse(env.target);
  const customEnvironmentIds = targetsSchema.parse(env.customEnvironmentIds);

  const matches =
    scope.kind === "target"
      ? targets.includes(scope.target)
      : customEnvironmentIds.includes(scope.customEnvironmentId);

  if (matches && env.key && env.id) {
    return {
      comment: env.comment,
      customEnvironmentIds,
      gitBranch: env.gitBranch || undefined,
      id: env.id,
      isManaged: isManagedEnv(env),
      key: env.key,
      targets,
      value: env.value ?? "",
      vercelType: isVercelVariableType(env.type) ? env.type : undefined,
    };
  }

  return null;
};

/**
 * Process array of environment variables
 */
const processEnvArray = (
  envs: RawVercelEnv[],
  scope: EnvironmentScope
): VercelExistingVariable[] => {
  const envVars: VercelExistingVariable[] = [];

  for (const env of envs) {
    const extracted = extractIfMatches(env, scope);

    if (extracted) {
      envVars.push(extracted);
    }
  }

  return envVars;
};

/**
 * Normalize value for comparison by trimming and handling quotes
 */
const normalizeValueForComparison = (value: string): string => {
  let normalized = value.trim();

  // Remove surrounding quotes if present
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  return normalized;
};

const logDebugUpdateReason = ({
  currentHash,
  currentVercelType,
  key,
  resolvedType,
  typeChanged,
}: {
  /** Hash from the variable's sync comment; `null` when it was never synced by this tool. */
  currentHash: string | null;
  /** Type Vercel reports for the existing variable, if recognised. */
  currentVercelType: VercelVariableType | undefined;
  /** Variable name printed in the `[DEBUG]` line. */
  key: string;
  /** Type this sync would write, from `resolveVercelType` (local type + environment). */
  resolvedType: VercelVariableType;
  /** Takes precedence over the hash comparison as the logged reason. */
  typeChanged: boolean;
}): void => {
  if (process.env.DEBUG !== "true") {
    return;
  }

  let reason: string;

  if (typeChanged) {
    reason = `type differs (${currentVercelType} -> ${resolvedType})`;
  } else if (currentHash === null) {
    reason = "no prior sync hash on this variable";
  } else {
    reason = "hash differs";
  }

  console.log(`[DEBUG] ${key}: ${reason}, will update`);
};

export class VercelService {
  private readonly vercel: Vercel;
  private projectId?: string;
  private teamId?: string;
  private readonly customEnvironmentIdCache = new Map<string, string>();

  constructor(vercel: Vercel) {
    this.vercel = vercel;
  }

  /**
   * Factory method to create and initialize a VercelService instance
   */
  static async create(token?: string): Promise<VercelService> {
    const vercelToken = token || (await VercelService.getLocalVercelToken());

    if (!vercelToken) {
      throw new VercelError(
        "Vercel token not found. Set VERCEL_TOKEN environment variable.",
        "TOKEN_NOT_FOUND"
      );
    }

    const vercel = new Vercel({
      bearerToken: vercelToken,
    });

    return new VercelService(vercel);
  }

  /**
   * Get local Vercel token from CLI auth file
   */
  private static async getLocalVercelToken(): Promise<string | null> {
    const configSchema = z.object({
      expiresAt: z.number(),
      refreshToken: z.string().optional(),
      token: z.string(),
    });

    const vercelAuthPath = path.join(
      process.env.HOME || "",
      "Library",
      "Application Support",
      "com.vercel.cli",
      "auth.json"
    );

    if (!(await FileOperations.fileExists(vercelAuthPath))) {
      VercelService.authViaVercelCLI();

      return VercelService.getLocalVercelToken();
    }

    try {
      const content = await FileOperations.readFile(vercelAuthPath);
      const authData = JSON.parse(content);
      const parsed = configSchema.parse(authData);

      if (parsed.expiresAt * 1000 < Date.now()) {
        VercelService.authViaVercelCLI();

        return VercelService.getLocalVercelToken();
      }

      return parsed.token || null;
    } catch (error) {
      console.warn(`Failed to read Vercel auth token: ${error}`);

      return null;
    }
  }

  /**
   * Authenticate via Vercel CLI
   */
  private static authViaVercelCLI(): void {
    process.stdout.write("Authenticating via Vercel CLI...\n");
    execFileSync(process.execPath, [resolvePackageBin("vercel"), "login"], {
      stdio: "inherit",
    });
  }

  /**
   * Check if app is linked to Vercel (has .vercel directory)
   */
  static async isLinked(appDirectory: string): Promise<boolean> {
    const vercelDir = path.join(appDirectory, ".vercel");

    return await FileOperations.dirExists(vercelDir);
  }

  /**
   * Get project configuration from .vercel/project.json
   */
  static async getProjectConfig(
    appDirectory: string
  ): Promise<VercelProjectConfig> {
    const projectJsonPath = path.join(appDirectory, ".vercel", "project.json");

    if (!(await FileOperations.fileExists(projectJsonPath))) {
      throw new VercelError(
        `App not linked to Vercel. Missing ${projectJsonPath}`,
        "NOT_LINKED",
        { appDirectory }
      );
    }

    try {
      const content = await FileOperations.readFile(projectJsonPath);
      const config = JSON.parse(content);

      return {
        orgId: config.orgId,
        projectId: config.projectId,
      };
    } catch (error) {
      throw new VercelError(
        "Failed to parse .vercel/project.json",
        "INVALID_PROJECT_CONFIG",
        { appDirectory, error }
      );
    }
  }

  /**
   * The project an app syncs to: its `VERCEL_PROJECT_ID` from app.config when
   * set (an app deployed from another repository has no `.vercel` link here),
   * otherwise the `.vercel` link in its directory. Null when it has neither.
   */
  static async resolveProject(
    app: Pick<AppConfig, "directory" | "vercelProjectId" | "vercelTeamId">
  ): Promise<VercelProjectConfig | null> {
    if (app.vercelProjectId) {
      return { orgId: app.vercelTeamId, projectId: app.vercelProjectId };
    }

    if (!app.directory) {
      return null;
    }

    const appDirectory = path.join(getProjectRoot(), app.directory);

    if (!(await VercelService.isLinked(appDirectory))) {
      return null;
    }

    return VercelService.getProjectConfig(appDirectory);
  }

  useProject({ orgId, projectId }: VercelProjectConfig): void {
    this.projectId = projectId;
    this.teamId = orgId;
  }

  private requireProjectId(): string {
    if (!this.projectId) {
      throw new VercelError(
        "Project not initialized. Call initializeProject() first.",
        "PROJECT_NOT_INITIALIZED"
      );
    }

    return this.projectId;
  }

  /**
   * Look up a Vercel Custom Environment's ID by its slug, caching the result.
   * Custom Environments are per-project, so this must run after
   * initializeProject().
   */
  private async getCustomEnvironmentId(slug: string): Promise<string> {
    const cached = this.customEnvironmentIdCache.get(slug);

    if (cached) {
      return cached;
    }

    const projectId = this.requireProjectId();

    const response =
      await this.vercel.environment.getProjectsByIdOrNameCustomEnvironments({
        idOrName: projectId,
        ...(this.teamId && { teamId: this.teamId }),
      });

    const match = response.environments.find((env) => env.slug === slug);

    if (!match) {
      throw new VercelError(
        `No Vercel Custom Environment found with slug "${slug}". Create it in the Vercel dashboard (Project Settings > Environments) first.`,
        "CUSTOM_ENVIRONMENT_NOT_FOUND",
        { slug }
      );
    }

    this.customEnvironmentIdCache.set(slug, match.id);

    return match.id;
  }

  /**
   * Resolve an Environment to the scope Vercel's API expects: a classic
   * target for production/preview/development, or a Custom Environment ID
   * for anything else (e.g. "staging").
   */
  private async resolveScope(
    environment: Environment
  ): Promise<EnvironmentScope> {
    if (isClassicTarget(environment)) {
      return { kind: "target", target: environment };
    }

    const customEnvironmentId = await this.getCustomEnvironmentId(environment);

    return { customEnvironmentId, kind: "custom" };
  }

  /**
   * Get all environment variables for a project
   */
  async getEnvironmentVariables(
    environment: Environment
  ): Promise<VercelExistingVariable[]> {
    const projectId = this.requireProjectId();

    try {
      const scope = await this.resolveScope(environment);

      const response = await this.vercel.projects.filterProjectEnvs({
        idOrName: projectId,
        ...(this.teamId && { teamId: this.teamId }),
      });

      // Convert response to JSON string for parsing
      const jsonString = JSON.stringify(response);

      // Try parsing as Type 1 (single env variable)
      const type1Result = filterProjectEnvsResponseBody1FromJSON(jsonString);

      if (type1Result.ok) {
        const extracted = extractIfMatches(type1Result.value, scope);

        return extracted ? [extracted] : [];
      }

      // Try parsing as Type 2 (array with pagination)
      const type2Result = filterProjectEnvsResponseBody2FromJSON(jsonString);

      if (type2Result.ok) {
        return processEnvArray(type2Result.value.envs, scope);
      }

      // Try parsing as Type 3 (simple array)
      const type3Result = filterProjectEnvsResponseBody3FromJSON(jsonString);

      if (type3Result.ok) {
        return processEnvArray(type3Result.value.envs, scope);
      }

      // If none of the parsing attempts succeeded, throw error
      throw new VercelError(
        "Failed to parse Vercel API response - unknown response format",
        "PARSE_FAILED",
        {
          environment,
          projectId: this.projectId,
          type1Error: type1Result.ok ? null : type1Result.error,
          type2Error: type2Result.ok ? null : type2Result.error,
          type3Error: type3Result.ok ? null : type3Result.error,
        }
      );
    } catch (error) {
      if (error instanceof VercelError) {
        throw error;
      }

      throw new VercelError(
        `Failed to fetch environment variables for ${environment}`,
        "FETCH_FAILED",
        { environment, error, projectId: this.projectId }
      );
    }
  }

  /**
   * Add new environment variable
   */
  async addEnvironmentVariable(
    key: string,
    value: string,
    environment: Environment,
    type: VercelVariableType
  ): Promise<void> {
    const projectId = this.requireProjectId();

    const scope = await this.resolveScope(environment);

    const create = (attemptType: VercelVariableType) =>
      this.vercel.projects.createProjectEnv({
        idOrName: projectId,
        ...(this.teamId && { teamId: this.teamId }),
        requestBody: {
          comment: buildSyncComment(value),
          key,
          type: attemptType,
          value,
          ...(scope.kind === "target"
            ? { target: [scope.target] }
            : { customEnvironmentIds: [scope.customEnvironmentId] }),
        },
      });

    try {
      try {
        await create(type);
      } catch (error) {
        const isSensitiveRejection =
          error instanceof Error && isSensitiveNotSupportedError(error);

        if (type !== "sensitive" || !isSensitiveRejection) {
          throw error;
        }

        console.warn(
          `  "sensitive" not supported for ${key} in ${environment}, falling back to "encrypted"`
        );
        await create("encrypted");
      }
    } catch (error) {
      throw new VercelError(
        `Failed to add environment variable: ${key}`,
        "ADD_FAILED",
        { environment, error, key, projectId: this.projectId }
      );
    }
  }

  /**
   * Update an existing variable's value and type. Its targets and custom
   * environments are sent back unchanged, because Vercel replaces them with
   * whatever the edit carries. Callers only update a variable that serves
   * this environment alone; a shared one is split instead (see
   * splitIntoEnvironment).
   */
  async updateEnvironmentVariable(
    currentVar: VercelExistingVariable,
    value: string,
    environment: Environment,
    type: VercelVariableType
  ): Promise<void> {
    const projectId = this.requireProjectId();

    const envId = currentVar.id ?? "";

    const update = (attemptType: VercelVariableType) =>
      this.vercel.projects.editProjectEnv({
        id: envId,
        idOrName: projectId,
        ...(this.teamId && { teamId: this.teamId }),
        requestBody: {
          comment: buildSyncComment(value),
          customEnvironmentIds: currentVar.customEnvironmentIds,
          target: currentVar.targets.filter(isClassicTarget),
          type: attemptType,
          value,
        },
      });

    try {
      try {
        await update(type);
      } catch (error) {
        const isSensitiveRejection =
          error instanceof Error && isSensitiveNotSupportedError(error);

        if (type !== "sensitive" || !isSensitiveRejection) {
          throw error;
        }

        console.warn(
          `  "sensitive" not supported for ${envId} in ${environment}, falling back to "encrypted"`
        );
        await update("encrypted");
      }
    } catch (error) {
      throw new VercelError(
        `Failed to update environment variable: ${envId}`,
        "UPDATE_FAILED",
        { envId, environment, error, projectId: this.projectId }
      );
    }
  }

  /**
   * Remove an environment variable by ID. Vercel's dashboard requires
   * removing and re-adding a variable to convert it to "sensitive" (rather
   * than an in-place edit) — see resolveVercelType and syncSingleVariable.
   */
  async removeEnvironmentVariable(envId: string): Promise<void> {
    const projectId = this.requireProjectId();

    try {
      await this.vercel.projects.removeProjectEnv({
        id: envId,
        idOrName: projectId,
        ...(this.teamId && { teamId: this.teamId }),
      });
    } catch (error) {
      throw new VercelError(
        `Failed to remove environment variable: ${envId}`,
        "REMOVE_FAILED",
        { envId, error, projectId: this.projectId }
      );
    }
  }

  /**
   * Takes a variable out of one environment only. A variable that also serves
   * other targets or custom environments is narrowed in place (no value is
   * sent, so it keeps its value there); one left with nothing is deleted.
   */
  async removeFromEnvironment(
    variable: VercelExistingVariable,
    environment: Environment
  ): Promise<"narrowed" | "removed"> {
    const projectId = this.requireProjectId();
    const scope = await this.resolveScope(environment);

    const target = variable.targets.filter(
      (name): name is ClassicTarget =>
        isClassicTarget(name) &&
        !(scope.kind === "target" && name === scope.target)
    );

    const customEnvironmentIds = variable.customEnvironmentIds.filter(
      (id) => scope.kind !== "custom" || id !== scope.customEnvironmentId
    );

    if (target.length === 0 && customEnvironmentIds.length === 0) {
      await this.removeEnvironmentVariable(variable.id ?? "");

      return "removed";
    }

    try {
      await this.vercel.projects.editProjectEnv({
        id: variable.id ?? "",
        idOrName: projectId,
        ...(this.teamId && { teamId: this.teamId }),
        requestBody: { customEnvironmentIds, target },
      });
    } catch (error) {
      throw new VercelError(
        `Failed to narrow ${variable.key} out of ${environment}`,
        "UPDATE_FAILED",
        { environment, error, key: variable.key, projectId }
      );
    }

    return "narrowed";
  }

  /**
   * Handle syncing a single variable (add or update based on existence)
   */
  private async syncSingleVariable(
    variable: EnvVariable,
    currentMap: Map<string, VercelExistingVariable>,
    environment: Environment,
    dryRun: boolean
  ): Promise<{ action: "added" | "updated" | "skipped"; error?: string }> {
    const normalizedNewValue = normalizeValueForComparison(variable.value);
    const resolvedType = resolveVercelType(variable.type, environment);
    const currentVar = currentMap.get(variable.key);

    if (currentVar) {
      return this.handleExistingVariable(
        variable,
        currentVar,
        normalizedNewValue,
        resolvedType,
        environment,
        dryRun
      );
    }

    // Variable doesn't exist - add it
    try {
      if (process.env.DEBUG === "true") {
        console.log(
          `[DEBUG] ${variable.key}: Variable does not exist in Vercel, will add as ${resolvedType}`
        );
      }

      if (!dryRun) {
        await this.addEnvironmentVariable(
          variable.key,
          variable.value,
          environment,
          resolvedType
        );
      }

      return { action: "added" };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      return { action: "added", error: errorMsg };
    }
  }

  /**
   * A Vercel variable holds one value across all its targets, so writing this
   * environment's differing value into a shared one would overwrite the
   * others' and flip back on their next sync. Instead the shared variable is
   * narrowed out of this environment (keeping its value elsewhere) and this
   * environment gets its own.
   */
  private async splitIntoEnvironment(
    variable: EnvVariable,
    currentVar: VercelExistingVariable,
    resolvedType: VercelVariableType,
    environment: Environment
  ): Promise<void> {
    await this.removeFromEnvironment(currentVar, environment);

    try {
      await this.addEnvironmentVariable(
        variable.key,
        variable.value,
        environment,
        resolvedType
      );
    } catch (error) {
      throw new VercelError(
        `${variable.key} was narrowed out of ${environment} to give it its own value there, but could not be re-added. It is now missing in ${environment}; re-run the sync or add it in the Vercel dashboard.`,
        "RECREATE_FAILED",
        { environment, error, key: variable.key }
      );
    }
  }

  /**
   * Converting a variable to or from "sensitive" is done as a delete-then-
   * recreate rather than an in-place edit — Vercel's dashboard only allows
   * in-place edits between "plain"/"encrypted", and requires delete+recreate
   * for any transition into or out of "sensitive".
   */
  private async applyVariableUpdate(
    variable: EnvVariable,
    currentVar: VercelExistingVariable,
    resolvedType: VercelVariableType,
    environment: Environment
  ): Promise<void> {
    const spansOtherEnvironments =
      currentVar.targets.length + currentVar.customEnvironmentIds.length > 1;

    if (spansOtherEnvironments) {
      await this.splitIntoEnvironment(
        variable,
        currentVar,
        resolvedType,
        environment
      );

      return;
    }

    if (needsTypeRecreate(currentVar.vercelType, resolvedType)) {
      await this.removeEnvironmentVariable(currentVar.id || "");

      try {
        await this.addEnvironmentVariable(
          variable.key,
          variable.value,
          environment,
          resolvedType
        );
      } catch (error) {
        // The old variable is already gone — try to put it back with its
        // prior type before giving up, so a failed conversion doesn't leave
        // the variable missing from Vercel entirely.
        if (currentVar.vercelType) {
          try {
            await this.addEnvironmentVariable(
              variable.key,
              variable.value,
              environment,
              currentVar.vercelType
            );
          } catch {
            // Restoration also failed — fall through to the loud error below.
          }
        }

        throw new VercelError(
          `${variable.key} was removed from Vercel to change its type to "${resolvedType}" but could not be recreated. It may now be missing in ${environment} — verify in the Vercel dashboard and re-add it manually if needed.`,
          "RECREATE_FAILED",
          { environment, error, key: variable.key }
        );
      }

      return;
    }

    await this.updateEnvironmentVariable(
      currentVar,
      variable.value,
      environment,
      resolvedType
    );
  }

  /**
   * Handle syncing for an existing variable. Change detection compares two
   * independent things: a hash of the new value against the hash stored in
   * the variable's comment (see SYNC_HASH_PREFIX) — never the value itself,
   * since Vercel's list endpoint never returns it and "sensitive"-type
   * variables never return it at all, from any endpoint — and the resolved
   * type against Vercel's current type, so a variable whose annotation
   * changed (or was added for the first time) still gets corrected even when
   * its value hasn't.
   */
  private async handleExistingVariable(
    variable: EnvVariable,
    currentVar: VercelExistingVariable,
    normalizedNewValue: string,
    resolvedType: VercelVariableType,
    environment: Environment,
    dryRun: boolean
  ): Promise<{ action: "updated" | "skipped"; error?: string }> {
    const currentHash = extractSyncedHash(currentVar.comment);
    const newHash = hashValue(normalizedNewValue);

    const typeChanged =
      currentVar.vercelType !== undefined &&
      currentVar.vercelType !== resolvedType;

    if (currentHash === newHash && !typeChanged) {
      if (process.env.DEBUG === "true") {
        console.log(`[DEBUG] ${variable.key}: Hash and type match, skipping`);
      }

      return { action: "skipped" };
    }

    logDebugUpdateReason({
      currentHash,
      currentVercelType: currentVar.vercelType,
      key: variable.key,
      resolvedType,
      typeChanged,
    });

    try {
      if (!dryRun) {
        await this.applyVariableUpdate(
          variable,
          currentVar,
          resolvedType,
          environment
        );
      }

      return { action: "updated" };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      return { action: "updated", error: errorMsg };
    }
  }

  /**
   * Sync environment variables to Vercel (smart upsert). Change detection
   * compares a hash of the new value against the hash stored in each
   * existing variable's comment (see SYNC_HASH_PREFIX) rather than reading
   * values back from Vercel.
   */
  async syncEnvironmentVariables(
    variables: EnvVariable[],
    environment: Environment,
    dryRun = false
  ): Promise<VercelSyncResult> {
    const result: VercelSyncResult = {
      added: 0,
      addedKeys: [],
      failed: [],
      skipped: 0,
      skippedKeys: [],
      updated: 0,
      updatedKeys: [],
    };

    // Get current state (keys and IDs only)
    const currentVars = await this.getEnvironmentVariables(environment);
    const currentMap = new Map(currentVars.map((v) => [v.key, v]));

    if (process.env.DEBUG === "true") {
      console.log(
        `[DEBUG] Fetched ${currentVars.length} variables from Vercel`
      );
      console.log(
        `[DEBUG] Variable keys: ${[...currentMap.keys()].join(", ")}`
      );
    }

    const ownedVariables = variables.filter((variable) => {
      if (!isExternallyManagedKey(variable.key)) {
        return true;
      }

      output.info(
        `  Skipped ${variable.key}: managed outside this CLI (externallyManagedKeys in env.config.json)`
      );

      return false;
    });

    // sequential to avoid Vercel API rate limits during bulk variable sync
    await mapSequentially(ownedVariables, async (variable) => {
      const { action, error } = await this.syncSingleVariable(
        variable,
        currentMap,
        environment,
        dryRun
      );

      if (error) {
        console.error(`Failed to sync ${variable.key}: ${error}`);
        result.failed.push(variable.key);
      } else if (action === "added") {
        result.added += 1;
        result.addedKeys.push(variable.key);
      } else if (action === "updated") {
        result.updated += 1;
        result.updatedKeys.push(variable.key);
      } else if (action === "skipped") {
        result.skipped += 1;
        result.skippedKeys.push(variable.key);
      }
    });

    return result;
  }
}
