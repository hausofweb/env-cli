import { ENVIRONMENTS } from "../constants/environments";
import { checkAndAuthenticateAWS } from "../lib/aws-credentials";
import { SopsService } from "../services/sops.service";
import type { Environment } from "../types/app-config.types";
import type { KeyLocation } from "./variable-locations";

/** Commander collector so `--env a --env b` and `--env a,b` both work. */
export const collectOption = (
  value: string,
  previous: string[] = []
): string[] => [...previous, value];

/** The environments named by every `--env`, each checked against the known ones. */
export const parseEnvironments = (raw: string[] | undefined): Environment[] => {
  const names = (raw ?? [])
    .join(",")
    .split(",")
    .map((name) => name.trim());

  if (!names.some(Boolean)) {
    throw new Error("--env is required with a KEY");
  }

  const environments = names.map((name) => {
    const environment = ENVIRONMENTS.find((known) => known === name);

    if (!environment) {
      throw new Error(
        `Unknown environment ${name}; expected one of ${ENVIRONMENTS.join(", ")}`
      );
    }

    return environment;
  });

  return [...new Set(environments)];
};

/** Nobody is at a prompt to confirm, so production needs the flag spelled out. */
export const assertProductionConfirmed = ({
  environments,
  isConfirmed,
}: {
  environments: Environment[];
  /** `--confirm-production`. */
  isConfirmed: boolean | undefined;
}): void => {
  if (environments.includes("production") && !isConfirmed) {
    throw new Error(
      "production is included; pass --confirm-production to write it without a prompt"
    );
  }
};

/**
 * The files to act on: one per environment, or every copy there when no
 * `--target` narrows it. An environment where the key (or the target's copy of
 * it) is missing is an error rather than a skip, so a typo can't pass silently.
 */
export const selectLocations = ({
  environments,
  key,
  locations,
  target,
}: {
  environments: Environment[];
  key: string;
  /** Every file defining `key` in those environments. */
  locations: KeyLocation[];
  /** `--target`: the one folder whose copy is wanted. */
  target: string | undefined;
}): KeyLocation[] =>
  environments.flatMap((environment) => {
    const here = locations.filter(
      (location) => location.environment === environment
    );

    if (here.length === 0) {
      throw new Error(`${key} is not defined in ${environment}`);
    }

    const picked = target
      ? here.filter(({ directory }) => directory === target)
      : here;

    if (picked.length === 0) {
      const found = here.map(({ directory }) => `${directory}/`).join(", ");

      throw new Error(
        `${key} has no copy in ${target}/ for ${environment}; it is in ${found}`
      );
    }

    return picked;
  });

export const authenticateForSops = async (): Promise<void> => {
  await checkAndAuthenticateAWS();
  SopsService.validateSopsInstalled();
};
