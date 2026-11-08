import type { Environment } from "../types/app-config.types";

export const ENVIRONMENTS: Environment[] = [
  "production",
  "staging",
  "preview",
  "development",
];

export const ENV_FILE_NAMES: Record<Environment, string> = {
  development: ".env.development",
  preview: ".env.preview",
  production: ".env.production",
  staging: ".env.staging",
};

export const ENV_FILE_NAMES_ENC: Record<Environment, string> = {
  development: ".env.development.enc",
  preview: ".env.preview.enc",
  production: ".env.production.enc",
  staging: ".env.staging.enc",
};
