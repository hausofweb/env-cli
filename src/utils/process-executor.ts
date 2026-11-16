import { execSync, spawn } from "node:child_process";
import { once } from "node:events";

import type { ExecOptions, ExecResult } from "../types/cli.types";

/**
 * Wrapper around child_process for consistent error handling and execution
 */
export const ProcessExecutor = {
  /**
   * Check if command exists in PATH
   */
  commandExists: (command: string): boolean => {
    try {
      execSync(`which ${command}`, { stdio: "pipe" });

      return true;
    } catch {
      return false;
    }
  },
  /**
   * Execute command and return result
   */
  exec: async (
    command: string,
    args: string[],
    options?: ExecOptions
  ): Promise<ExecResult> => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: options?.silent ? "pipe" : "inherit",
    });

    let stdout = "";
    let stderr = "";

    if (options?.silent) {
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
    }

    // Rejects with the spawn error if "error" fires before "close".
    const [exitCode]: (number | null)[] = await once(proc, "close");

    if (exitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${exitCode}: ${stderr || stdout}`
      );
    }

    return { exitCode, stderr, stdout };
  },

  /**
   * Execute shell command (for piping values)
   */
  execShell: (
    shellCommand: string,
    options?: ExecOptions
  ): Promise<ExecResult> =>
    ProcessExecutor.exec("sh", ["-c", shellCommand], options),

  /**
   * Execute command synchronously (for simple checks)
   */
  execSync: (command: string, options?: ExecOptions): string => {
    try {
      return execSync(command, {
        cwd: options?.cwd,
        encoding: "utf-8",
        env: { ...process.env, ...options?.env },
      });
    } catch (error) {
      throw new Error(`Command failed: ${command}\n${error}`, { cause: error });
    }
  },
};
