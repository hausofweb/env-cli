import path from "node:path";

import { SopsError } from "../types/sops-error";
import { FileOperations } from "../utils/file-operations";
import { ProcessExecutor as defaultProcessExecutor } from "../utils/process-executor";

// Env file names (.env.development, etc.) have no extension sops recognizes,
// so without an explicit type it silently falls back to opaque binary mode —
// one unreadable blob per file, no visibility into which keys changed in a
// diff. dotenv mode keeps keys in plaintext and only encrypts values.
const SOPS_DOTENV_FLAGS = ["--input-type", "dotenv", "--output-type", "dotenv"];

// `sops edit` exits with this when the editor left the file as it was.
const SOPS_UNCHANGED_EXIT_CODE = 200;
const SOPS_DOTENV_VERSION_LINE = /^sops_version=/mu;
const SOPS_DOTENV_MAC_LINE = /^sops_mac=/mu;

/** Records only the size of sops's error output: it can echo the plaintext. */
const encryptFailed = (
  inputPath: string,
  outputPath: string,
  errorDetails: string
) =>
  new SopsError(`Failed to encrypt file: ${inputPath}`, "ENCRYPT_FAILED", {
    errorDetailsLength: errorDetails.length,
    hasErrorDetails: errorDetails.length > 0,
    inputPath,
    outputPath,
  });

export interface SopsServiceDependencies {
  /** Runs the `sops` binary. */
  ProcessExecutor: Pick<
    typeof defaultProcessExecutor,
    "commandExists" | "exec"
  >;
}

/**
 * Service for SOPS encryption and decryption operations
 */
export const createSopsService = ({
  ProcessExecutor,
}: SopsServiceDependencies) => {
  const SopsService = {
    /**
     * Re-encrypts only what changed: sops opens the ciphertext, hands the
     * decrypted text to `$EDITOR`, and re-encrypts values that differ from
     * what it decrypted. `cp` as the editor makes the plaintext file the edit.
     */
    applyPlaintext: async (
      inputPath: string,
      outputPath: string
    ): Promise<void> => {
      // sops shell-splits EDITOR before appending its temp file, so the path
      // must be one quoted word.
      const editor = `cp ${JSON.stringify(path.resolve(inputPath))}`;

      try {
        await ProcessExecutor.exec(
          "sops",
          ["edit", ...SOPS_DOTENV_FLAGS, outputPath],
          { env: { EDITOR: editor }, silent: true }
        );
      } catch (error) {
        const isUnchanged =
          error instanceof Error &&
          error.message.startsWith(
            `Command failed with exit code ${SOPS_UNCHANGED_EXIT_CODE}:`
          );

        if (!isUnchanged) {
          throw encryptFailed(
            inputPath,
            outputPath,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    },
    /**
     * Decrypt file using SOPS
     */
    decrypt: async (inputPath: string): Promise<string> => {
      SopsService.validateSopsInstalled();

      if (!(await FileOperations.fileExists(inputPath))) {
        throw new SopsError(`File not found: ${inputPath}`, "FILE_NOT_FOUND", {
          inputPath,
        });
      }

      try {
        const result = await ProcessExecutor.exec(
          "sops",
          [...SOPS_DOTENV_FLAGS, "--decrypt", inputPath],
          { silent: true }
        );

        return result.stdout;
      } catch (error) {
        // Safe to surface sops's stderr here: decrypt takes ciphertext in, so
        // a failure reports *why* (e.g. a KMS AccessDeniedException) and never
        // echoes secrets. encrypt below deliberately does NOT do this — its
        // stderr can include the plaintext it was handed.
        const cause = error instanceof Error ? error.message : String(error);
        throw new SopsError(
          `Failed to decrypt file: ${inputPath}\n${cause}`,
          "DECRYPT_FAILED",
          { error, inputPath }
        );
      }
    },

    /**
     * Encrypt file using SOPS. An output that is already encrypted is updated
     * in place through `sops edit`, which keeps the ciphertext of every value
     * and comment that did not change — a one-key edit is a one-line diff,
     * where a fresh `--encrypt` would mint a new IV for every line.
     */
    encrypt: async (inputPath: string, outputPath: string): Promise<void> => {
      SopsService.validateSopsInstalled();

      if (!(await FileOperations.fileExists(inputPath))) {
        throw new SopsError(`File not found: ${inputPath}`, "FILE_NOT_FOUND", {
          inputPath,
        });
      }

      if (await SopsService.isEncrypted(outputPath)) {
        await SopsService.applyPlaintext(inputPath, outputPath);

        return;
      }

      try {
        const result = await ProcessExecutor.exec(
          "sops",
          [...SOPS_DOTENV_FLAGS, "--encrypt", inputPath],
          { silent: true }
        );

        const stderr = result.stderr?.trim();

        if (stderr) {
          console.warn(
            `SOPS returned stderr during encryption (${stderr.length} chars).`
          );
        }

        await FileOperations.writeFile(outputPath, result.stdout);
      } catch (error) {
        throw encryptFailed(
          inputPath,
          outputPath,
          error instanceof Error ? error.message : String(error)
        );
      }
    },

    /**
     * Check if file is encrypted with SOPS
     */
    isEncrypted: async (filePath: string): Promise<boolean> => {
      if (!(await FileOperations.fileExists(filePath))) {
        return false;
      }

      try {
        const content = await FileOperations.readFile(filePath);

        // Binary/JSON-wrapped sops output nests metadata as "sops": {...
        // "version": ...}; dotenv/ini output flattens it into sops_version=
        // and sops_mac= lines instead — check for either so this keeps working
        // across sops output formats. Both dotenv keys
        // are required: encrypt() routes on this, and a plaintext that merely
        // mentions the version must not be handed to `sops edit`.
        return (
          (content.includes("sops:") && content.includes("version:")) ||
          (SOPS_DOTENV_VERSION_LINE.test(content) &&
            SOPS_DOTENV_MAC_LINE.test(content))
        );
      } catch {
        return false;
      }
    },
    /**
     * Check if SOPS is installed
     */
    isSopsInstalled: (): boolean => ProcessExecutor.commandExists("sops"),

    /**
     * Validate SOPS is installed, throw if not
     */
    validateSopsInstalled: (): void => {
      if (!SopsService.isSopsInstalled()) {
        throw new SopsError(
          "SOPS is not installed. Please install SOPS to continue.",
          "SOPS_NOT_INSTALLED"
        );
      }
    },
  };

  return SopsService;
};

export const SopsService = createSopsService({
  ProcessExecutor: defaultProcessExecutor,
});
