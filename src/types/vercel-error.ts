import { EnvManagementError } from "./env-management-error";
import type { EnvErrorContext } from "./env-management-error";

export class VercelError extends EnvManagementError {
  constructor(
    message: string,
    code = "VERCEL_ERROR",
    context?: EnvErrorContext
  ) {
    super(message, code, context);
    this.name = "VercelError";
  }
}
