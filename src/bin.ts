#!/usr/bin/env node

import { runInteractiveEnvMode } from "./interactive";
import { createEnvProgram } from "./program";
import { isExitPromptError } from "./utils/prompt-errors";

// No arguments beyond node and the script path: prompt for what to run
// instead of requiring the caller to remember command names and flags.
const hasArguments = process.argv.length > 2;

const runInteractive = async (): Promise<void> => {
  try {
    await runInteractiveEnvMode({ hasMainMenu: false });
  } catch (error) {
    if (isExitPromptError(error)) {
      console.log("\nCancelled.");
      process.exitCode = 0;

      return;
    }

    console.error(
      error instanceof Error ? error.message : "Interactive mode failed"
    );
    process.exitCode = 1;
  }
};

if (hasArguments) {
  createEnvProgram().parse(process.argv);
} else {
  runInteractive();
}
