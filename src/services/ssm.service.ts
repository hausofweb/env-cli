import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

/** AWS SSM parameter tier; mirrors the `# String`/`# SecureString` headers. */
export type SSMParameterType = "String" | "SecureString";

/** Arguments to `SSMService.putParameter`. */
export interface PutSSMParameterInput {
  /** Report the would-be action without calling `PutParameter`. */
  dryRun?: boolean;
  /** Full SSM parameter path, e.g. `/development/STRIPE_SECRET_KEY`. */
  name: string;
  /** Desired type; a type change deletes and recreates the parameter. */
  type: SSMParameterType;
  /** Plaintext value; SSM encrypts it when `type` is SecureString. */
  value: string;
}

/** Outcome of `SSMService.putParameter` for one parameter. */
export interface PutSSMParameterResult {
  /** `skipped` when SSM already holds the same type and value. */
  action: "created" | "updated" | "skipped";
  /** SSM parameter path, echoed from the input. */
  name: string;
  /** Type the parameter has (or would have) after the call. */
  type: SSMParameterType;
}

/** Arguments to `SSMService.deleteParameter`. */
export interface DeleteSSMParameterInput {
  /** Report the would-be action without calling `DeleteParameter`. */
  dryRun?: boolean;
  /** Full SSM parameter path to remove. */
  name: string;
}

/** Outcome of `SSMService.deleteParameter` for one parameter. */
export interface DeleteSSMParameterResult {
  /** `skipped` when SSM reported `ParameterNotFound`. */
  action: "deleted" | "skipped";
  /** SSM parameter path, echoed from the input. */
  name: string;
}

let ssmClient = new SSMClient({});

const getExistingParameter = async ({
  name,
}: {
  /** Full SSM path; `ParameterNotFound` reads as `exists: false`. */
  name: string;
}): Promise<{
  exists: boolean;
  type?: string;
  value?: string;
}> => {
  try {
    const existing = await ssmClient.send(
      new GetParameterCommand({
        Name: name,
        WithDecryption: true,
      })
    );

    return {
      exists: existing.Parameter !== undefined,
      type: existing.Parameter?.Type,
      value: existing.Parameter?.Value,
    };
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ParameterNotFound") {
      throw error;
    }

    return {
      exists: false,
    };
  }
};

/** One decrypted parameter returned by `GetParametersByPath`. */
export interface SSMParameterEntry {
  /** Full SSM path; callers take the last `/` segment as the key. */
  name: string;
  /** Decrypted value (fetched `WithDecryption`); empty ones are dropped. */
  value: string;
}

export const SSMService = {
  deleteParameter: async ({
    dryRun = false,
    name,
  }: DeleteSSMParameterInput): Promise<DeleteSSMParameterResult> => {
    const existingParameter = await getExistingParameter({ name });

    if (!existingParameter.exists) {
      return {
        action: "skipped",
        name,
      };
    }

    if (dryRun) {
      return {
        action: "deleted",
        name,
      };
    }

    await ssmClient.send(
      new DeleteParameterCommand({
        Name: name,
      })
    );

    return {
      action: "deleted",
      name,
    };
  },
  /**
   * Lists every parameter under a path prefix (e.g. `/development/cdkOutputs/`) —
   * for reading a whole namespace CDK writes to, as opposed to getParameter's
   * single named lookup.
   */
  listParametersByPath: async ({
    path,
  }: {
    /** `GetParametersByPath` prefix, non-recursive, e.g. `/<env>/cdkOutputs/`. */
    path: string;
  }): Promise<SSMParameterEntry[]> => {
    const entries: SSMParameterEntry[] = [];

    // pages are inherently sequential (each depends on the previous page's NextToken)
    const collectPage = async (nextToken?: string): Promise<void> => {
      const page = await ssmClient.send(
        new GetParametersByPathCommand({
          NextToken: nextToken,
          Path: path,
          WithDecryption: true,
        })
      );

      for (const param of page.Parameters ?? []) {
        if (param.Name && param.Value) {
          entries.push({ name: param.Name, value: param.Value });
        }
      }

      if (page.NextToken) {
        await collectPage(page.NextToken);
      }
    };

    await collectPage();

    return entries;
  },

  putParameter: async ({
    dryRun = false,
    name,
    type,
    value,
  }: PutSSMParameterInput): Promise<PutSSMParameterResult> => {
    const existingParameter = await getExistingParameter({ name });
    const hasExisting = existingParameter.exists;
    const hasDifferentType = hasExisting && existingParameter.type !== type;

    if (
      hasExisting &&
      existingParameter.type === type &&
      existingParameter.value === value
    ) {
      return { action: "skipped", name, type };
    }

    if (dryRun) {
      return {
        action: hasExisting ? "updated" : "created",
        name,
        type,
      };
    }

    if (hasDifferentType) {
      await SSMService.deleteParameter({ name });
    }

    await ssmClient.send(
      new PutParameterCommand({
        DataType: "text",
        Name: name,
        Overwrite: true,
        Type: type,
        Value: value,
      })
    );

    return {
      action: hasExisting ? "updated" : "created",
      name,
      type,
    };
  },
  resetClient: () => {
    ssmClient = new SSMClient({});
  },
};
