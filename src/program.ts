import { createRequire } from "node:module";

import { Command } from "commander";

import { addCommand } from "./commands/add";
import { copyCommand } from "./commands/copy";
import { decryptCommand } from "./commands/decrypt";
import { deleteLocalCommand } from "./commands/delete-local";
import { encryptCommand } from "./commands/encrypt";
import { listAppsCommand } from "./commands/list-apps";
import { removeCommand } from "./commands/remove";
import { setupLocalCommand } from "./commands/setup-local";
import { syncSSMCommand } from "./commands/sync-ssm";
import { syncVercelCommand } from "./commands/sync-vercel";
import { tidyCommand } from "./commands/tidy";
import { updateCommand } from "./commands/update";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const createEnvProgram = ({
  commands = [],
}: {
  /** Extra commander commands to register beside the built-in ones. */
  commands?: Command[];
} = {}): Command => {
  const program = new Command();

  program
    .name("hwenv")
    .description("Environment variable management for multi-app monorepos")
    .version(version);

  program.addCommand(decryptCommand);
  program.addCommand(encryptCommand);
  program.addCommand(addCommand);
  program.addCommand(updateCommand);
  program.addCommand(copyCommand);
  program.addCommand(removeCommand);
  program.addCommand(tidyCommand);
  program.addCommand(syncVercelCommand);
  program.addCommand(syncSSMCommand);
  program.addCommand(setupLocalCommand);
  program.addCommand(listAppsCommand);
  program.addCommand(deleteLocalCommand);

  for (const command of commands) {
    program.addCommand(command);
  }

  return program;
};
