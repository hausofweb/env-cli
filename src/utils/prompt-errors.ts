/**
 * True when the user cancelled an @inquirer/prompts prompt (Ctrl+C or Esc),
 * which rejects with an ExitPromptError rather than signaling a real
 * failure. Checked by error name rather than importing @inquirer/core (a
 * transitive, not direct, dependency of this package) to avoid coupling to
 * its internal package structure.
 */
export const isExitPromptError = (error: unknown): error is Error =>
  error instanceof Error && error.name === "ExitPromptError";
