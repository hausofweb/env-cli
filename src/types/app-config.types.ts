export type AppType = "vercel" | "non-vercel" | "local-only";

export type Environment = "production" | "staging" | "preview" | "development";

export interface AppConfig {
  /**
   * Repo-relative app root that receives `.env.local` and holds the `.vercel`
   * link; undefined for an app deployed from another repository.
   */
  directory?: string;
  /** Repository the app deploys from when it isn't this one, e.g. `hausofweb/documenso`. */
  externalRepository?: string;
  name: string;
  type: AppType;
  vercelProject?: string;
  /** Vercel project ID; names the project when there is no `.vercel` link to read. */
  vercelProjectId?: string;
  /** Vercel team ID that owns `vercelProjectId`. */
  vercelTeamId?: string;
}

export interface AppConfigFile {
  APP_DIRECTORY?: string;
  APP_TYPE?: string;
  EXTERNAL_REPOSITORY?: string;
  VERCEL_PROJECT?: string;
  VERCEL_PROJECT_ID?: string;
  VERCEL_TEAM_ID?: string;
}
