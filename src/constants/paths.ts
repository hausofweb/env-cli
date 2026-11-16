import path from "node:path";

import { getEnvContext } from "../config";

export const getProjectRoot = (): string => getEnvContext().root;

/** Encrypted env storage; consumers get their vars via the generated .env.local in their own directory. */
export const getEnvDir = (): string => {
  const { config, root } = getEnvContext();

  return path.resolve(root, config.envDir);
};

export const getSharedEnvDir = (): string => path.join(getEnvDir(), "shared");

export const defaultAppDirectory = (appName: string) => `apps/${appName}`;

export const APP_CONFIG_FILENAME = "app.config";
export const SOPS_CONFIG_FILENAME = ".sops.yaml";
