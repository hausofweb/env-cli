import { spawnSync } from "node:child_process";

import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";

import { ENVIRONMENTS } from "./constants/environments";

/** `env` submenu pick; each value is the commander subcommand it runs. */
type MenuCommand =
  | "decrypt"
  | "encrypt"
  | "add"
  | "update"
  | "copy"
  | "remove"
  | "tidy"
  | "sync"
  | "sync-ssm"
  | "setup"
  | "list"
  | "delete-local";

/** Commands that either take no arguments or prompt for everything themselves. */
const SELF_PROMPTING_COMMANDS = [
  "add",
  "copy",
  "encrypt",
  "list",
  "remove",
  "tidy",
] as const satisfies readonly MenuCommand[];

const isSelfPrompting = (
  command: MenuCommand
): command is (typeof SELF_PROMPTING_COMMANDS)[number] =>
  SELF_PROMPTING_COMMANDS.some((candidate) => candidate === command);

/** How the user left the env menu: back to a parent menu, or out of the CLI. */
export type EnvMenuExit = "back" | "exit";

interface EnvMenuOptions {
  /** Opened from a parent menu, so Back has somewhere to go. */
  hasMainMenu: boolean;
}

const selectCommand = async ({
  hasMainMenu,
}: EnvMenuOptions): Promise<MenuCommand | EnvMenuExit> =>
  await select({
    choices: [
      {
        description: "Decrypt environment files and create .env.local files",
        name: "Decrypt",
        value: "decrypt" as const,
      },
      {
        description: "Encrypt all environment files with SOPS",
        name: "Encrypt",
        value: "encrypt" as const,
      },
      {
        description: "Add a new environment variable (interactive wizard)",
        name: "Add variable",
        value: "add" as const,
      },
      {
        description:
          "Change an existing variable's value in place (rotate a secret) or which apps see it",
        name: "Update variable",
        value: "update" as const,
      },
      {
        description:
          "Find a variable and copy its value to the clipboard (masked preview, nothing written to disk)",
        name: "Copy a variable to clipboard",
        value: "copy" as const,
      },
      {
        description:
          "Retire a variable entirely — encrypted files, Vercel and SSM",
        name: "Remove variable",
        value: "remove" as const,
      },
      {
        description:
          "Move shared/ variables that only one app sees into that app's own folder",
        name: "Tidy shared variables",
        value: "tidy" as const,
      },
      {
        description: "Sync environment variables to Vercel",
        name: "Sync to Vercel",
        value: "sync" as const,
      },
      {
        description: "Sync selected environment variables to AWS SSM",
        name: "Sync to SSM",
        value: "sync-ssm" as const,
      },
      {
        description: "Setup local development environment for an app",
        name: "Setup local dev environment",
        value: "setup" as const,
      },
      {
        description: "List all apps with their types",
        name: "List apps",
        value: "list" as const,
      },
      {
        description: "Delete all .env.local files",
        name: "Delete local .env files",
        value: "delete-local" as const,
      },
      ...(hasMainMenu
        ? [
            {
              description: "Return to the main menu",
              name: "Back to main menu",
              value: "back" as const,
            },
          ]
        : []),
      {
        description: "Exit the CLI",
        name: "Exit",
        value: "exit" as const,
      },
    ],
    message: "Select an env command to run:",
  });

const selectEnvironment = async (includeAll: boolean): Promise<string> =>
  await select({
    choices: [
      ...ENVIRONMENTS.map((environment) => ({
        name: environment,
        value: environment,
      })),
      ...(includeAll ? [{ name: "all", value: "all" }] : []),
    ],
    message: "Select an environment:",
  });

const selectPruneFlags = async ({
  dryRun,
}: {
  dryRun: boolean;
}): Promise<string[]> => {
  const prune = await confirm({
    default: false,
    message:
      "Also list Vercel variables the encrypted files no longer define (prune)?",
  });

  if (!prune) {
    return [];
  }

  if (dryRun) {
    return ["--prune"];
  }

  const apply = await confirm({
    default: false,
    message: "Remove them? You'll still confirm each project and environment.",
  });

  return [apply ? "--confirm-prune" : "--prune"];
};

/** Prompts for the command's arguments; undefined when the user backs out. */
const promptForArgs = async (
  command: MenuCommand
): Promise<string[] | undefined> => {
  const args: string[] = [command];

  if (isSelfPrompting(command)) {
    return args;
  }

  switch (command) {
    case "decrypt": {
      args.push(await selectEnvironment(true));

      const includeNonVercel = await confirm({
        default: true,
        message: "Include non-Vercel apps too?",
      });

      if (includeNonVercel) {
        args.push("--all");
      }

      break;
    }

    case "update": {
      const target = await select({
        choices: [
          { name: "Its value (rotate a secret)", value: "value" as const },
          {
            name: "Which apps see it (its # @apps: tag, which also decides SSM)",
            value: "apps" as const,
          },
        ],
        message: "Change what?",
      });

      if (target === "apps") {
        args.push("--apps");
      }

      break;
    }

    case "sync":
    case "sync-ssm": {
      args.push(await selectEnvironment(true));

      const dryRun = await confirm({
        default: true,
        message: "Dry run (preview only, no changes made)?",
      });

      if (dryRun) {
        args.push("--dry-run");
      }

      if (command === "sync") {
        args.push(...(await selectPruneFlags({ dryRun })));
      }

      break;
    }

    case "setup": {
      args.push(
        await input({
          default: "all",
          message: 'App name to setup (or "all" for all apps):',
        })
      );
      break;
    }

    case "delete-local": {
      const proceed = await confirm({
        default: false,
        message: "This deletes every app's .env.local file. Continue?",
      });

      if (!proceed) {
        console.log(chalk.yellow("\nCancelled.\n"));

        return undefined;
      }

      break;
    }

    default: {
      const exhaustiveCheck: never = command;
      throw new Error(`Unhandled command: ${exhaustiveCheck}`);
    }
  }

  return args;
};

// Commands end with process.exit(), so each runs in a child process to keep
// this menu alive for the next pick.
const runEnvCommand = (args: string[]): void => {
  const { error, status } = spawnSync(
    process.execPath,
    [...process.execArgv, process.argv[1] ?? "", ...args],
    { stdio: "inherit" }
  );

  if (error) {
    console.error(chalk.red(`Could not run env ${args[0]}: ${error.message}`));
  }

  if (status !== 0) {
    process.exitCode = 1;
  }
};

/** Loops until Back, Exit or a cancelled prompt, so several commands run in one session. */
const runEnvMenuLoop = async (
  options: EnvMenuOptions
): Promise<EnvMenuExit> => {
  const command = await selectCommand(options);

  if (command === "back" || command === "exit") {
    return command;
  }

  const args = await promptForArgs(command);

  if (args) {
    runEnvCommand(args);
  }

  return runEnvMenuLoop(options);
};

export const runInteractiveEnvMode = async (
  options: EnvMenuOptions
): Promise<EnvMenuExit> => {
  console.log(chalk.bold.cyan("\n╔══════════════════════════════════════╗"));
  console.log(chalk.bold.cyan("║      Env Variable Management CLI     ║"));
  console.log(chalk.bold.cyan("╚══════════════════════════════════════╝\n"));

  return await runEnvMenuLoop(options);
};
