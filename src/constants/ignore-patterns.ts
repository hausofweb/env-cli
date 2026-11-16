// Directories to ignore in env/
export const IGNORE_DIRS = [
  "shared",
  ".temp",
  "examples",
  "templates",
  ".git",
  "node_modules",
];

// Regex patterns to ignore: hidden, underscore-prefixed, backup, old, test
// and temporary directories
export const IGNORE_PATTERNS = [
  /^\./u,
  /^_/u,
  /\.bak$/u,
  /\.old$/u,
  /^test-/u,
  /^tmp-/u,
];
