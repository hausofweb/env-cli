import chalk from "chalk";

/**
 * Colored console output utilities matching shell script format
 */
export const output = {
  debug: (message: string, ...args: unknown[]) => {
    if (process.env.DEBUG) {
      console.log(chalk.gray(`[DEBUG] ${message}`), ...args);
    }
  },

  error: (message: string, ...args: unknown[]) => {
    console.error(chalk.red(`✗ ${message}`), ...args);
  },
  info: (message: string, ...args: unknown[]) => {
    console.log(chalk.cyan(message), ...args);
  },

  log: (message: string, ...args: unknown[]) => {
    console.log(message, ...args);
  },

  section: (title: string) => {
    console.log();
    console.log(chalk.blue("━".repeat(60)));
    console.log(chalk.blue(title));
    console.log(chalk.blue("━".repeat(60)));
    console.log();
  },

  success: (message: string, ...args: unknown[]) => {
    console.log(chalk.green(`✓ ${message}`), ...args);
  },

  warning: (message: string, ...args: unknown[]) => {
    console.warn(chalk.yellow(`⚠ ${message}`), ...args);
  },
};
