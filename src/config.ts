import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Environment } from "./types/app-config.types";

export const ENV_CONFIG_FILENAME = "env.config.json";

const awsProfilesSchema = z.object({
  development: z.string().optional(),
  preview: z.string().optional(),
  production: z.string().optional(),
  staging: z.string().optional(),
});

const envConfigSchema = z.object({
  awsProfiles: awsProfilesSchema.optional(),
  envDir: z.string().min(1).default("env"),
  externallyManagedKeys: z.array(z.string()).default([]),
  ssm: z
    .object({
      optional: z.array(z.string()).default([]),
      required: z.array(z.string()).default([]),
    })
    .optional(),
});

export type EnvConfig = z.infer<typeof envConfigSchema>;

export interface EnvContext {
  config: EnvConfig;
  /** Absolute directory holding `env.config.json`. */
  root: string;
}

const findConfigRoot = (startDir: string): string => {
  let current = path.resolve(startDir);

  while (!existsSync(path.join(current, ENV_CONFIG_FILENAME))) {
    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(
        `Could not find ${ENV_CONFIG_FILENAME} in ${startDir} or any parent directory. Create it at the repository root.`
      );
    }

    current = parent;
  }

  return current;
};

const readConfig = (root: string): EnvConfig => {
  const configPath = path.join(root, ENV_CONFIG_FILENAME);
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error: unknown) {
    throw new Error(
      `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const parsed = envConfigSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`Invalid ${configPath}: ${z.prettifyError(parsed.error)}`);
  }

  return parsed.data;
};

let cachedContext: EnvContext | undefined;

/** Finds `env.config.json` by walking up from `startDir` and caches the result for the process. */
export const getEnvContext = (startDir = process.cwd()): EnvContext => {
  if (!cachedContext) {
    const root = findConfigRoot(startDir);
    cachedContext = { config: readConfig(root), root };
  }

  return cachedContext;
};

/** Replaces (or, with undefined, clears) the cached context; for tests that point the CLI at a fixture. */
export const setEnvContext = (context: EnvContext | undefined): void => {
  cachedContext = context;
};

export const getAwsProfile = (environment: Environment): string => {
  const profile = getEnvContext().config.awsProfiles?.[environment];

  if (!profile) {
    throw new Error(
      `No AWS profile for ${environment}. Add awsProfiles.${environment} to ${ENV_CONFIG_FILENAME}.`
    );
  }

  return profile;
};

export const getSsmKeys = (): { optional: string[]; required: string[] } => {
  const { ssm } = getEnvContext().config;

  return { optional: ssm?.optional ?? [], required: ssm?.required ?? [] };
};

export const hasSsmConfig = (): boolean =>
  getEnvContext().config.ssm !== undefined;

export const isExternallyManagedKey = (key: string): boolean =>
  getEnvContext().config.externallyManagedKeys.includes(key);

export const buildSsmPath = ({
  environment,
  key,
}: {
  environment: string;
  key: string;
}): string => `/${environment}/${key}`;
