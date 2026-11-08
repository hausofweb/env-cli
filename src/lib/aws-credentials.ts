/**
 * AWS Credentials Validation and Authentication Utilities
 * Uses shared AWS SDK resolution with credential_process support.
 */

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import { loadSharedConfigFiles as defaultLoadSharedConfigFiles } from "@smithy/shared-ini-file-loader";
import chalk from "chalk";

/** Why credential resolution failed; lets the CLI print a targeted remedy. */
type AWSCredentialsErrorCode =
  | "AWS_CREDENTIALS_ERROR"
  | "AUTH_REQUIRED"
  | "SSO_AUTH_FAILURE"
  | "NO_AWS_CLI"
  | "MISSING_SSO_CONFIG"
  | "POLICY_VIOLATION";

export class AWSCredentialsError extends Error {
  readonly code: AWSCredentialsErrorCode;

  constructor(
    message: string,
    code: AWSCredentialsErrorCode = "AWS_CREDENTIALS_ERROR"
  ) {
    super(message);
    this.name = "AWSCredentialsError";
    this.code = code;
  }
}

/** Profile assumed when a blocked production profile is dropped or none is set. */
const DEFAULT_AWS_PROFILE = "dev";

const CI_ENVIRONMENT_VARIABLES = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "TRAVIS",
  "CIRCLECI",
] as const;

const isCIEnvironment = (): boolean =>
  CI_ENVIRONMENT_VARIABLES.some((name) => Boolean(process.env[name]));

const isProdProfile = (profile: string | null): boolean =>
  !!profile && profile.toLowerCase().includes("prod");

export const isBlockedProdProfile = (profile: string | null): boolean =>
  isProdProfile(profile) && !isCIEnvironment();

/** Collaborators of the credential checks; tests inject fakes, the default instance the real ones. */
export interface AwsCredentialsDependencies {
  /** STS identity of whatever credentials the SDK resolves right now (the active AWS_PROFILE). */
  getCallerIdentity: () => Promise<
    Pick<GetCallerIdentityCommandOutput, "Account" | "Arn" | "UserId">
  >;
  /** Reads ~/.aws/config, where a profile's region is looked up. */
  loadSharedConfigFiles: typeof defaultLoadSharedConfigFiles;
}

/** Builds the credential checks over the given STS lookup and config reader. */
export const createAwsCredentials = ({
  getCallerIdentity,
  loadSharedConfigFiles,
}: AwsCredentialsDependencies) => {
  const ensureRegionFromProfile = async (
    profile: string | null
  ): Promise<void> => {
    if (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) {
      return;
    }

    if (!profile) {
      return;
    }

    try {
      const configFiles = await loadSharedConfigFiles({ ignoreCache: true });
      const profileConfig = configFiles.configFile?.[profile];
      const region = profileConfig?.region ?? profileConfig?.granted_sso_region;

      if (region) {
        process.env.AWS_REGION = region;
        console.log(
          chalk.gray(`Region resolved from profile config: ${region}`)
        );
      }
    } catch {
      // Profile config not available — region must be set via other means
    }
  };

  const checkAWSCredentials = async (options?: {
    /** Lets a local shell use a "prod" AWS_PROFILE instead of throwing POLICY_VIOLATION; CI is always allowed. */
    allowProduction?: boolean;
  }): Promise<boolean> => {
    console.log(chalk.blue("🔍 Checking AWS credentials...\n"));

    const profile = process.env.AWS_PROFILE ?? null;

    if (profile) {
      console.log(chalk.gray(`Using profile: ${profile}`));
    }

    if (!options?.allowProduction && isBlockedProdProfile(profile)) {
      throw new AWSCredentialsError(
        "Production profiles are not allowed in local environments for safety reasons.",
        "POLICY_VIOLATION"
      );
    }

    try {
      const response = await getCallerIdentity();

      console.log(chalk.green("✓ AWS credentials are valid!\n"));
      console.log(chalk.gray("Account ID:"), response.Account);
      console.log(chalk.gray("User ARN:"), response.Arn);
      console.log(chalk.gray("User ID:"), response.UserId);

      if (profile) {
        console.log(chalk.gray("Profile:"), profile);
      }

      console.log("");

      if (response.Account) {
        process.env.CDK_DEFAULT_ACCOUNT = response.Account;
        process.env.AWS_ACCOUNT_ID = response.Account;
      }

      await ensureRegionFromProfile(profile);

      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ExpiredTokenException") {
        console.log(
          chalk.yellow(
            "⚠️  AWS session token has expired. Please re-authenticate and retry.\n"
          )
        );

        return false;
      }

      console.log(chalk.red("✗ AWS credentials are invalid or not found.\n"));
      console.error(
        chalk.gray("Error details:"),
        error instanceof Error ? error.message : String(error)
      );

      return false;
    }
  };

  const checkAndAuthenticateAWS = async (options?: {
    /** Keeps a local "prod" AWS_PROFILE instead of falling back to the default profile. */
    allowProduction?: boolean;
  }): Promise<void> => {
    process.env.AWS_SDK_LOAD_CONFIG ??= "1";

    // A blocked prod profile left over from an earlier `assume` in this shell
    // shouldn't hard-fail commands that don't actually need production access —
    // fall back to the default profile the same way a missing/invalid profile
    // already does below, instead of throwing.
    if (
      !options?.allowProduction &&
      isBlockedProdProfile(process.env.AWS_PROFILE ?? null)
    ) {
      console.log(
        chalk.yellow(
          `⚠️  Ignoring blocked production profile "${process.env.AWS_PROFILE}" — falling back to ${DEFAULT_AWS_PROFILE}.\n`
        )
      );
      process.env.AWS_PROFILE = DEFAULT_AWS_PROFILE;
    }

    // A sourced `assume` leaves session keys in the shell beside AWS_PROFILE, and they
    // outlive a later `aws sso login` (a child process can't refresh its parent's env).
    // This SDK resolves through AWS_PROFILE, but sops and the aws CLI prefer the static
    // keys, so stale ones fail KMS even though the check below passes. Drop them so every
    // subprocess resolves through the same profile — including leftover production keys
    // after the fallback above.
    if (process.env.AWS_PROFILE) {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_SESSION_TOKEN;
    }

    if (await checkAWSCredentials(options)) {
      return;
    }

    const profile = process.env.AWS_PROFILE ?? DEFAULT_AWS_PROFILE;

    throw new AWSCredentialsError(
      `Run \`aws sso login --profile ${profile}\` to authenticate, then retry.`,
      "AUTH_REQUIRED"
    );
  };

  return { checkAWSCredentials, checkAndAuthenticateAWS };
};

export const { checkAndAuthenticateAWS, checkAWSCredentials } =
  createAwsCredentials({
    // A fresh client per call: a client caches the credentials it first resolves,
    // which would outlive the AWS_PROFILE fallback checkAndAuthenticateAWS applies.
    getCallerIdentity: () =>
      new STSClient({ region: "us-east-1" }).send(
        new GetCallerIdentityCommand({})
      ),
    loadSharedConfigFiles: defaultLoadSharedConfigFiles,
  });
