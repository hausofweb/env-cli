import { afterEach, beforeEach } from "vitest";

import { setEnvContext } from "../config";

beforeEach(() => {
  setEnvContext({
    config: {
      awsProfiles: {
        development: "dev",
        preview: "preview",
        production: "prod",
        staging: "staging",
      },
      envDir: "env",
      externallyManagedKeys: [
        "NEXT_PUBLIC_SENTRY_DSN",
        "SENTRY_AUTH_TOKEN",
        "SENTRY_DSN",
        "SENTRY_ORG",
        "SENTRY_PROJECT",
        "SENTRY_URL",
      ],
    },
    root: "/repo",
  });
});

afterEach(() => {
  setEnvContext(undefined);
});
