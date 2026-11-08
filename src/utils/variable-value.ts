import { confirm, password } from "@inquirer/prompts";

import { mapSequentially } from "../lib/async";
import type { Environment } from "../types/app-config.types";

const NEWLINE_PATTERN = /[\r\n]/u;

/** Quotes are doubled up on write, so both have to survive a round trip. */
export const escapeEnvValue = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export const promptValue = (key: string, label: string): Promise<string> =>
  password({
    mask: "*",
    message: `Value for ${key} (${label}):`,
    validate: (raw) => {
      if (raw.length === 0) {
        return "Value cannot be empty";
      }

      if (NEWLINE_PATTERN.test(raw)) {
        return "Value cannot contain newline characters";
      }

      return true;
    },
  });

export const promptValuesPerEnvironment = async (
  key: string,
  environments: Environment[]
): Promise<Map<Environment, string>> => {
  const [first, ...rest] = environments;
  const firstValue = await promptValue(key, first);
  const values = new Map<Environment, string>([[first, firstValue]]);

  if (rest.length === 0) {
    return values;
  }

  const reuseFirstValue = await confirm({
    default: true,
    message: `Use the same value for the remaining ${rest.length} environment(s) (${rest.join(", ")})?`,
  });

  if (reuseFirstValue) {
    for (const environment of rest) {
      values.set(environment, firstValue);
    }

    return values;
  }

  // sequential prompts must run one at a time
  await mapSequentially(rest, async (environment) => {
    values.set(environment, await promptValue(key, environment));
  });

  return values;
};
