import { EnvManagementError } from "./env-management-error";
import type { EnvErrorContext } from "./env-management-error";

export class SopsError extends EnvManagementError {
  constructor(message: string, code = "SOPS_ERROR", context?: EnvErrorContext) {
    super(message, code, context);
    this.name = "SopsError";
  }
}
