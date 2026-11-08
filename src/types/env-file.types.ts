/** One `KEY=value` pair, from a decrypted env file or a Vercel listing. */
export interface EnvVariable {
  /** Vercel environment variable ID */
  id?: string;
  /** Variable name as written left of `=` in the env file. */
  key: string;
  /** Source annotation ("# String" / "# SecureString"), if present. */
  type?: "String" | "SecureString";
  /** Unquoted value; from a Vercel listing it is never the decrypted value. */
  value: string;
}

const ENV_LINE_TYPES = ["variable", "comment", "empty", "directive"] as const;

/** How a `.env` line was classified; a `directive` is a `# @apps:` or `# @global` comment. */
type EnvLineType = (typeof ENV_LINE_TYPES)[number];

/** One classified line from `EnvFilterService.parseEnvLine`. */
export interface EnvLine {
  /** Parsed scope change; set only when `type` is `directive`. */
  directive?: {
    /** `global` resets scope to every app; `apps` narrows it to `apps`. */
    type: "apps" | "global";
    /** Comma-separated names after `# @apps:`, trimmed; absent for `@global`. */
    apps?: string[];
  };
  /** Variable name; set only when `type` is `variable`. */
  key?: string;
  /** Untrimmed original text, re-emitted verbatim when filtering a file. */
  raw: string;
  /** Classification that decides which other fields are set. */
  type: EnvLineType;
  /** Value with surrounding quotes stripped; set only for `variable`. */
  value?: string;
}
