/**
 * Diagnostic details attached to an env CLI error; each thrower fills only
 * the fields relevant to the operation that failed.
 */
export interface EnvErrorContext {
  /** App directory whose Vercel project link was being read. */
  appDirectory?: string;
  /** App name that discovery could not find. */
  appName?: string;
  /** App names discovery did find, offered as suggestions. */
  availableApps?: string[];
  /** Vercel env var record ID being updated or removed. */
  envId?: string;
  /** Target environment, e.g. `development` or the `staging` custom environment. */
  environment?: string;
  /** Underlying error from the SDK or child process. */
  error?: unknown;
  /** Character count of sops' stderr, logged instead of its contents. */
  errorDetailsLength?: number;
  /** Whether sops wrote anything to stderr. */
  hasErrorDetails?: boolean;
  /** Source file passed to sops (plaintext to encrypt or `.enc` to decrypt). */
  inputPath?: string;
  /** Env variable name the operation was acting on. */
  key?: string;
  /** Encrypted `.enc` file sops was writing. */
  outputPath?: string;
  /** Vercel project ID from the app's `.vercel/project.json` link. */
  projectId?: string;
  /** Vercel Custom Environment slug that has no matching environment. */
  slug?: string;
  /** Parse error for the single-variable shape of `filterProjectEnvs`. */
  type1Error?: unknown;
  /** Parse error for the paginated-array shape of `filterProjectEnvs`. */
  type2Error?: unknown;
  /** Parse error for the plain-array shape of `filterProjectEnvs`. */
  type3Error?: unknown;
}

export class EnvManagementError extends Error {
  readonly code?: string;
  readonly context?: EnvErrorContext;

  constructor(message: string, code?: string, context?: EnvErrorContext) {
    super(message);
    this.name = "EnvManagementError";
    this.code = code;
    this.context = context;
  }
}
