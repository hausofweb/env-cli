/**
 * Clears AWS static-credential env vars before switching to a different profile — the SDK's
 * default provider chain reads static env credentials (e.g. left in the shell by a sourced
 * `assume`) before AWS_PROFILE, so lingering ones would be used instead of the target profile's.
 */
const AWS_PROFILE_ENV_VARS = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

/** Captures the AWS profile, credential and region variables; the returned function puts them back, unsetting any that were unset. */
export const snapshotAWSEnvVars = (): (() => void) => {
  const saved = AWS_PROFILE_ENV_VARS.map(
    (name) => [name, process.env[name]] as const
  );

  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  };
};

export const clearAWSCredentialEnvVars = (): void => {
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
};
