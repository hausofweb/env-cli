import { readFile } from "node:fs/promises";

import type { GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type { loadSharedConfigFiles } from "@smithy/shared-ini-file-loader";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

import { AWSCredentialsError, createAwsCredentials } from "./aws-credentials";

const sendMock =
  vi.fn<
    () => Promise<
      Pick<GetCallerIdentityCommandOutput, "Account" | "Arn" | "UserId">
    >
  >();

const { checkAWSCredentials, checkAndAuthenticateAWS } = createAwsCredentials({
  getCallerIdentity: sendMock,
  // Region lookup reads ~/.aws/config; keep the suite hermetic from the developer's machine.
  loadSharedConfigFiles: vi
    .fn<typeof loadSharedConfigFiles>()
    .mockResolvedValue({ configFile: {}, credentialsFile: {} }),
});

/** Module specifiers that would let the credential checks start a process. */
const SUBPROCESS_MODULES = ["child_process", "execa", "zx"];

const CI_ENVIRONMENT_VARIABLES = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "TRAVIS",
  "CIRCLECI",
] as const;

const VALID_IDENTITY = {
  Account: "123456789012",
  Arn: "arn:aws:iam::123456789012:user/test",
  UserId: "AIDAEXAMPLE",
};

describe("aws-credentials credential_process migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_PROFILE;
    delete process.env.CDK_DEFAULT_ACCOUNT;
    delete process.env.AWS_ACCOUNT_ID;
    delete process.env.AWS_SDK_LOAD_CONFIG;

    // The prod-profile block is lifted under CI, so these tests model a local shell
    // even when the suite itself runs in GitHub Actions.
    for (const name of CI_ENVIRONMENT_VARIABLES) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not require fromSSO pre-resolution when STS credentials are valid", async () => {
    process.env.AWS_PROFILE = "dev";
    sendMock.mockResolvedValue(VALID_IDENTITY);

    await expect(checkAWSCredentials()).resolves.toBe(true);
    expect(process.env.CDK_DEFAULT_ACCOUNT).toBe("123456789012");
    expect(process.env.AWS_ACCOUNT_ID).toBe("123456789012");
  });

  it("falls back to the default profile when the active profile is a blocked prod profile", async () => {
    process.env.AWS_PROFILE = "prod";
    sendMock.mockResolvedValue(VALID_IDENTITY);

    await expect(checkAndAuthenticateAWS()).resolves.toBeUndefined();
    expect(process.env.AWS_PROFILE).toBe("dev");
  });

  it("clears leftover static credentials when falling back from a blocked prod profile", async () => {
    process.env.AWS_PROFILE = "prod";
    process.env.AWS_ACCESS_KEY_ID = "PROD_ACCESS_KEY";
    process.env.AWS_SECRET_ACCESS_KEY = "PROD_SECRET_KEY";
    process.env.AWS_SESSION_TOKEN = "PROD_SESSION_TOKEN";
    sendMock.mockResolvedValue(VALID_IDENTITY);

    await expect(checkAndAuthenticateAWS()).resolves.toBeUndefined();

    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(process.env.AWS_PROFILE).toBe("dev");
  });

  // sops reads static keys before AWS_PROFILE; expired ones from an earlier `assume`
  // made encrypt fail after this check had passed through the refreshed profile.
  it("clears static credentials whenever a profile is active so subprocesses resolve through it", async () => {
    process.env.AWS_PROFILE = "preview";
    process.env.AWS_ACCESS_KEY_ID = "STALE_ACCESS_KEY";
    process.env.AWS_SECRET_ACCESS_KEY = "STALE_SECRET_KEY";
    process.env.AWS_SESSION_TOKEN = "STALE_SESSION_TOKEN";
    sendMock.mockResolvedValue(VALID_IDENTITY);

    await expect(checkAndAuthenticateAWS()).resolves.toBeUndefined();

    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(process.env.AWS_PROFILE).toBe("preview");
  });

  it("keeps static credentials when no profile is set, since they are the only source", async () => {
    process.env.AWS_ACCESS_KEY_ID = "CI_ACCESS_KEY";
    process.env.AWS_SECRET_ACCESS_KEY = "CI_SECRET_KEY";
    sendMock.mockResolvedValue(VALID_IDENTITY);

    await expect(checkAndAuthenticateAWS()).resolves.toBeUndefined();

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("CI_ACCESS_KEY");
  });

  it("does not fall back when allowProduction is set", async () => {
    process.env.AWS_PROFILE = "prod";
    sendMock.mockResolvedValue(VALID_IDENTITY);

    await expect(
      checkAndAuthenticateAWS({ allowProduction: true })
    ).resolves.toBeUndefined();
    expect(process.env.AWS_PROFILE).toBe("prod");
  });

  it("throws AUTH_REQUIRED pointing at `aws sso login --profile <profile>`", async () => {
    process.env.AWS_PROFILE = "staging";
    sendMock.mockRejectedValue(new Error("missing credentials"));

    await expect(checkAndAuthenticateAWS()).rejects.toSatisfy((err) => {
      expect(err).toBeInstanceOf(AWSCredentialsError);
      expect(err).toMatchObject({
        code: "AUTH_REQUIRED",
        message: expect.stringContaining("`aws sso login --profile staging`"),
      });

      return true;
    });
    expect(sendMock).toHaveBeenCalledOnce();
    expect(process.env.AWS_SDK_LOAD_CONFIG).toBe("1");
  });

  it("names the default profile in the login hint when AWS_PROFILE is unset", async () => {
    sendMock.mockRejectedValue(new Error("missing credentials"));

    await expect(checkAndAuthenticateAWS()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("aws sso login --profile dev"),
    });
  });

  // Login is an explicit `aws sso login` step; a subprocess import here would
  // mean credential checks started shelling out to `assume` (or anything else) again.
  it("never spawns anything: the module imports no subprocess API", async () => {
    const source = await readFile(
      new URL("aws-credentials.ts", import.meta.url),
      "utf-8"
    );

    for (const moduleName of SUBPROCESS_MODULES) {
      expect(source).not.toContain(`"${moduleName}"`);
      expect(source).not.toContain(`"node:${moduleName}"`);
    }
  });
});
