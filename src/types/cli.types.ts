import type { Environment } from "./app-config.types";

export interface DecryptOptions {
  all?: boolean;
  app?: string;
  environment?: Environment;
  noCopy?: boolean;
}

export interface SyncOptions {
  dryRun?: boolean;
}

export interface SetupOptions {
  all?: boolean;
  app: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  silent?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}
