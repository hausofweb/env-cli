import { EnvManagementError } from "./env-management-error";

export class AppNotFoundError extends EnvManagementError {
  constructor(appName: string, availableApps?: string[]) {
    super(`App not found: ${appName}`, "APP_NOT_FOUND", {
      appName,
      availableApps,
    });
    this.name = "AppNotFoundError";
  }
}
