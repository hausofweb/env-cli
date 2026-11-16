import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SopsService as defaultSopsService } from "../services/sops.service";

export interface UpdateEncryptedEnvFileDependencies {
  /** Decrypts the current file and re-encrypts the edited plaintext. */
  SopsService: Pick<
    typeof defaultSopsService,
    "decrypt" | "encrypt" | "isEncrypted"
  >;
}

/**
 * Rewrites an existing SOPS-encrypted env file. The plaintext only ever sits
 * in a private `mkdtemp` directory, removed whatever happens, never beside the
 * `.enc` in the repo. That relies on `SopsService.encrypt` updating an
 * already-encrypted file through `sops edit`, which keeps the file's own keys;
 * a first encryption goes through `env encrypt` instead. Returns whether the
 * content changed.
 */
export const createUpdateEncryptedEnvFile =
  ({ SopsService }: UpdateEncryptedEnvFileDependencies) =>
  async ({
    encPath,
    mutate,
  }: {
    /** The `.env.<environment>.enc` file to rewrite. */
    encPath: string;
    /** Returns the new plaintext; returning it unchanged skips the write. */
    mutate: (content: string) => Promise<string> | string;
  }): Promise<boolean> => {
    if (!(await SopsService.isEncrypted(encPath))) {
      throw new Error(
        `${encPath} is missing or not SOPS-encrypted. Create it with \`env encrypt\` first.`
      );
    }

    const content = await SopsService.decrypt(encPath);
    const nextContent = await mutate(content);

    if (nextContent === content) {
      return false;
    }

    const scratchDir = await mkdtemp(path.join(tmpdir(), "hwenv-"));

    try {
      const plaintextPath = path.join(
        scratchDir,
        path.basename(encPath, ".enc")
      );

      await writeFile(plaintextPath, nextContent, { mode: 0o600 });
      await SopsService.encrypt(plaintextPath, encPath);
    } finally {
      await rm(scratchDir, { force: true, recursive: true });
    }

    return true;
  };

export const updateEncryptedEnvFile = createUpdateEncryptedEnvFile({
  SopsService: defaultSopsService,
});
