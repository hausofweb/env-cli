import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvContext } from "../config";
import { SSMService } from "../services/ssm.service";
import type {
  DeleteSSMParameterInput,
  PutSSMParameterInput,
} from "../services/ssm.service";
import { output } from "../utils/cli-output";
import {
  handleSyncSSMCommand,
  syncSSMCommand,
  syncSSMCommandDependencies,
} from "./sync-ssm";

const REQUIRED_SSM_KEYS = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "SUDO_EMAIL",
  "AWS_SES_IDENTITY_ARN",
  "CLERK_SECRET_KEY",
  "STRIPE_WEBHOOK_RELAY_SECRET",
];

const OPTIONAL_SSM_KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "CALENDAR_WEBHOOK_RELAY_SECRET",
  "OUTBOX_RELAY_URL",
  "CRON_SECRET",
];

const useSsmConfig = (): void => {
  setEnvContext({
    config: {
      awsProfiles: { development: "dev" },
      envDir: "env",
      externallyManagedKeys: [],
      ssm: { optional: OPTIONAL_SSM_KEYS, required: REQUIRED_SSM_KEYS },
    },
    root: "/repo",
  });
};

/** The variables SSM should see: shared/ keys tagged for infra, plus infra/. */
const LOCAL_VARIABLES = {
  AWS_SES_IDENTITY_ARN:
    "arn:aws:ses:us-east-1:123456789012:identity/example.com",
  CLERK_SECRET_KEY: "clerk-secret",
  DATABASE_URL: "postgres://db",
  STRIPE_SECRET_KEY: "stripe-secret",
  STRIPE_WEBHOOK_RELAY_SECRET: "relay-secret",
  SUDO_EMAIL: "admin@example.com",
};

// CALENDAR_WEBHOOK_RELAY_SECRET is an optional SSM key tagged for api only, so SSM must treat it
// as absent. Its `# SecureString` sits right above an untyped infra-tagged
// NEXT_PUBLIC_APP_URL, which must stay untyped (and so unsynced) rather than
// inherit the dropped key's annotation.
const SHARED_CONTENT = `# @apps: api, app, scripts, infra
# SecureString
DATABASE_URL="postgres://db"
# SecureString
STRIPE_SECRET_KEY="stripe-secret"
# SecureString
CLERK_SECRET_KEY="clerk-secret"
# String
SUDO_EMAIL="admin@example.com"

# @apps: api
# SecureString
CALENDAR_WEBHOOK_RELAY_SECRET="api-only"

# @apps: infra
NEXT_PUBLIC_APP_URL="https://app.example.com"

# @apps: api, infra
# SecureString
STRIPE_WEBHOOK_RELAY_SECRET="relay-secret"
`;

const INFRA_CONTENT = `# String
AWS_SES_IDENTITY_ARN="arn:aws:ses:us-east-1:123456789012:identity/example.com"
`;

const silenceOutput = (): void => {
  for (const method of [
    "section",
    "warning",
    "success",
    "log",
    "error",
    "info",
  ] as const) {
    vi.spyOn(output, method).mockReturnValue(undefined);
  }
};

/** Any command `SSMClient.send` accepts, captured by the stubbed `send` for assertions. */
type SSMCommand = Parameters<typeof SSMClient.prototype.send>[0];

describe(handleSyncSSMCommand, () => {
  beforeEach(useSsmConfig);

  afterEach(() => {
    vi.restoreAllMocks();
    setEnvContext(undefined);
  });

  it("does nothing, without failing, when env.config.json has no ssm section", async () => {
    setEnvContext({
      config: { envDir: "env", externallyManagedKeys: [] },
      root: "/repo",
    });
    const validateSopsInstalled = vi.spyOn(
      syncSSMCommandDependencies,
      "validateSopsInstalled"
    );
    const putParameter = vi.spyOn(syncSSMCommandDependencies, "putParameter");
    silenceOutput();

    await expect(handleSyncSSMCommand("all", {})).resolves.toBe(false);
    expect(validateSopsInstalled).not.toHaveBeenCalled();
    expect(putParameter).not.toHaveBeenCalled();
  });

  it("exposes --delete-absent-optional on the CLI", () => {
    expect(
      syncSSMCommand.options.some(
        (option) => option.long === "--delete-absent-optional"
      )
    ).toBe(true);
  });

  it("deletes absent optional parameters and syncs the present ones", async () => {
    vi.spyOn(
      syncSSMCommandDependencies,
      "checkAndAuthenticateAWS"
    ).mockResolvedValue(undefined);
    vi.spyOn(
      syncSSMCommandDependencies,
      "clearAWSCredentialEnvVars"
    ).mockReturnValue(undefined);
    vi.spyOn(syncSSMCommandDependencies, "resetSSMClient").mockReturnValue(
      undefined
    );
    vi.spyOn(
      syncSSMCommandDependencies,
      "validateSopsInstalled"
    ).mockReturnValue(undefined);

    vi.spyOn(syncSSMCommandDependencies, "decrypt").mockImplementation(
      (filePath: string) =>
        Promise.resolve(
          filePath.includes("shared") ? SHARED_CONTENT : INFRA_CONTENT
        )
    );
    vi.spyOn(syncSSMCommandDependencies, "fileExists").mockResolvedValue(true);

    silenceOutput();

    const deleted: string[] = [];
    const put: string[] = [];

    const deleteParameter = vi
      .spyOn(syncSSMCommandDependencies, "deleteParameter")
      .mockImplementation(({ name }: DeleteSSMParameterInput) => {
        deleted.push(name);

        return Promise.resolve({ action: "deleted" as const, name });
      });

    const putParameter = vi
      .spyOn(syncSSMCommandDependencies, "putParameter")
      .mockImplementation(({ name, type }: PutSSMParameterInput) => {
        put.push(name);

        return Promise.resolve({ action: "created" as const, name, type });
      });

    const failed = await handleSyncSSMCommand("development", {
      deleteAbsentOptional: true,
    });

    expect(failed).toBe(false);

    // Exact, and ordered: this is the contract the sync keeps with SSM.
    expect(putParameter.mock.calls.map((call) => call[0])).toStrictEqual([
      {
        dryRun: false,
        name: "/development/DATABASE_URL",
        type: "SecureString",
        value: "postgres://db",
      },
      {
        dryRun: false,
        name: "/development/STRIPE_SECRET_KEY",
        type: "SecureString",
        value: "stripe-secret",
      },
      {
        dryRun: false,
        name: "/development/CLERK_SECRET_KEY",
        type: "SecureString",
        value: "clerk-secret",
      },
      {
        dryRun: false,
        name: "/development/SUDO_EMAIL",
        type: "String",
        value: "admin@example.com",
      },
      {
        dryRun: false,
        name: "/development/STRIPE_WEBHOOK_RELAY_SECRET",
        type: "SecureString",
        value: "relay-secret",
      },
      {
        dryRun: false,
        name: "/development/AWS_SES_IDENTITY_ARN",
        type: "String",
        value: "arn:aws:ses:us-east-1:123456789012:identity/example.com",
      },
    ]);

    // Deletion is asserted as a rule rather than a hardcoded list, so it
    // survives the next optional key. The api-only CALENDAR_WEBHOOK_RELAY_SECRET counts as absent and is
    // deleted; NEXT_PUBLIC_APP_URL is in scope but untyped, which warns instead
    // (and the exact put list above already shows it wasn't synced).
    const expectedDeletions = OPTIONAL_SSM_KEYS.filter(
      (key) => !(key in LOCAL_VARIABLES) && key !== "NEXT_PUBLIC_APP_URL"
    ).map((key) => `/development/${key}`);

    expect(new Set(deleted)).toStrictEqual(new Set(expectedDeletions));
    expect(deleteParameter.mock.calls[0]?.[0]).toMatchObject({ dryRun: false });

    // Nothing the sync just wrote may also have been deleted.
    expect(deleted.filter((name) => put.includes(name))).toStrictEqual([]);
  });
});

describe("SSMService.putParameter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips updating when the remote parameter has the same type and value", async () => {
    const commands: SSMCommand[] = [];

    vi.spyOn(SSMClient.prototype, "send").mockImplementation(
      (command: SSMCommand) => {
        commands.push(command);

        if (command instanceof GetParameterCommand) {
          return Promise.resolve({
            Parameter: {
              Name: "/development/DATABASE_URL",
              Type: "SecureString",
              Value: "postgres://db",
            },
          });
        }

        return Promise.reject(new Error("Unexpected AWS SSM command"));
      }
    );

    const result = await SSMService.putParameter({
      name: "/development/DATABASE_URL",
      type: "SecureString",
      value: "postgres://db",
    });

    expect(result).toStrictEqual({
      action: "skipped",
      name: "/development/DATABASE_URL",
      type: "SecureString",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetParameterCommand);
  });

  // SSM won't change a parameter's type in place, so the service has to remove
  // it and recreate it — and must do so in that order, or the value is lost.
  it("deletes and recreates a parameter when the remote type differs", async () => {
    const commandOrder: string[] = [];

    vi.spyOn(SSMClient.prototype, "send").mockImplementation(
      (command: SSMCommand) => {
        if (command instanceof GetParameterCommand) {
          commandOrder.push(`get:${command.input.Name}`);

          return Promise.resolve({
            Parameter: {
              Name: command.input.Name,
              Type: "SecureString",
              Value: "admin@example.com",
            },
          });
        }

        if (command instanceof DeleteParameterCommand) {
          commandOrder.push(`aws-delete:${command.input.Name}`);

          return Promise.resolve({});
        }

        if (command instanceof PutParameterCommand) {
          commandOrder.push(
            `aws-put:${command.input.Name}:${command.input.Type}`
          );

          return Promise.resolve({ Version: 1 });
        }

        return Promise.reject(new Error("Unexpected AWS SSM command"));
      }
    );

    const originalDeleteParameter = SSMService.deleteParameter.bind(SSMService);

    const deleteParameter = vi
      .spyOn(SSMService, "deleteParameter")
      .mockImplementation(
        ({ dryRun = false, name }: DeleteSSMParameterInput) => {
          commandOrder.push(`service-delete:${name}`);

          return originalDeleteParameter({ dryRun, name });
        }
      );

    const result = await SSMService.putParameter({
      name: "/development/SUDO_EMAIL",
      type: "String",
      value: "admin@example.com",
    });

    expect(result).toStrictEqual({
      action: "updated",
      name: "/development/SUDO_EMAIL",
      type: "String",
    });
    expect(deleteParameter).toHaveBeenCalledExactlyOnceWith({
      name: "/development/SUDO_EMAIL",
    });
    expect(commandOrder).toStrictEqual([
      "get:/development/SUDO_EMAIL",
      "service-delete:/development/SUDO_EMAIL",
      "get:/development/SUDO_EMAIL",
      "aws-delete:/development/SUDO_EMAIL",
      "aws-put:/development/SUDO_EMAIL:String",
    ]);
  });
});
