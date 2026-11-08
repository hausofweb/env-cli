/**
 * Clears AWS static-credential env vars before switching to a different profile — the SDK's
 * default provider chain reads static env credentials (e.g. left in the shell by a sourced
 * `assume`) before AWS_PROFILE, so lingering ones would be used instead of the target profile's.
 */
export const clearAWSCredentialEnvVars = (): void => {
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
};
