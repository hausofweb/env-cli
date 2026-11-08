import type { AWSCredentialsError } from "../lib/aws-credentials";
import { output } from "./cli-output";

/**
 * Login errors carry the exact `aws sso login --profile <profile>` command in their
 * message, so they get no generic hint that would name the wrong profile.
 */
const getAWSCredentialsGuidance = (
  code: AWSCredentialsError["code"]
): string | null => {
  switch (code) {
    case "AUTH_REQUIRED":
    case "SSO_AUTH_FAILURE": {
      return null;
    }

    case "NO_AWS_CLI": {
      return 'Install AWS CLI first (macOS: "brew install awscli")';
    }

    case "MISSING_SSO_CONFIG": {
      return 'Configure SSO with "aws configure sso" and try again';
    }

    case "POLICY_VIOLATION": {
      return "Use a non-production AWS profile with the required IAM permissions";
    }

    default: {
      return "Review your AWS credentials and configuration, then retry";
    }
  }
};

export const outputAWSCredentialsError = (error: AWSCredentialsError): void => {
  output.error(error.message);
  const guidance = getAWSCredentialsGuidance(error.code);

  if (guidance) {
    output.info(guidance);
  }
};
