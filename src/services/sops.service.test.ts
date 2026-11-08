import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeOf } from "../testing/fake";
import type { ProcessExecutor } from "../utils/process-executor";
import { createSopsService } from "./sops.service";

/** Signature of `ProcessExecutor.exec`, stubbed so no real `sops` binary runs. */
type Exec = typeof ProcessExecutor.exec;

const execMock = vi.fn<Exec>();

const SopsService = createSopsService({
  ProcessExecutor: fakeOf<typeof ProcessExecutor>()({
    commandExists: () => true,
    exec: execMock,
  }),
});

// The dotenv flags are the whole point: without them sops falls
// back to opaque binary mode and PR diffs stop showing which keys changed.
// These tests exist so that regression can't slip through silently.
const DOTENV_FLAGS = ["--input-type", "dotenv", "--output-type", "dotenv"];

describe("SopsService encrypt/decrypt", () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(path.join(tmpdir(), "sops-service-test-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("decrypt passes the dotenv flags to sops", async () => {
    const inputPath = path.join(dir, ".env.development.enc");
    await writeFile(inputPath, "KEY=ENC[...]\nsops_version=3.13.3\n");
    execMock.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: 'KEY="value"\n',
    });

    await expect(SopsService.decrypt(inputPath)).resolves.toBe('KEY="value"\n');
    expect(execMock).toHaveBeenCalledWith(
      "sops",
      [...DOTENV_FLAGS, "--decrypt", inputPath],
      { silent: true }
    );
  });

  // When sops fails, ProcessExecutor.exec's error message carries sops's
  // stderr — the actual reason (e.g. a KMS AccessDeniedException). Losing it
  // turned a CI failure into a multi-step IAM investigation.
  it("decrypt surfaces sops's underlying error, since ciphertext in can't leak secrets", async () => {
    const inputPath = path.join(dir, ".env.staging.enc");
    await writeFile(inputPath, "KEY=ENC[...]\nsops_version=3.13.3\n");
    execMock.mockRejectedValue(
      new Error(
        "Command failed with exit code 1: kms: AccessDeniedException: not authorized"
      )
    );

    await expect(SopsService.decrypt(inputPath)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
      message: expect.stringContaining("AccessDeniedException"),
    });
  });

  // encrypt is handed the PLAINTEXT, and sops can echo it back in stderr on
  // failure — so its error must stay generic. Guards against anyone later
  // making it symmetric with decrypt.
  it("encrypt does NOT surface sops's underlying error, since it could contain plaintext", async () => {
    const inputPath = path.join(dir, ".env.development");
    const outputPath = path.join(dir, ".env.development.enc");
    await writeFile(inputPath, 'SECRET="super-secret-value"\n');
    execMock.mockRejectedValue(
      new Error(
        'Command failed with exit code 1: bad line SECRET="super-secret-value"'
      )
    );

    await expect(
      SopsService.encrypt(inputPath, outputPath)
    ).rejects.toMatchObject({
      code: "ENCRYPT_FAILED",
      message: expect.not.stringContaining("super-secret-value"),
    });
  });

  it("encrypt passes the dotenv flags to sops and writes stdout to the output path", async () => {
    const inputPath = path.join(dir, ".env.development");
    const outputPath = path.join(dir, ".env.development.enc");
    await writeFile(inputPath, 'KEY="value"\n');
    execMock.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "KEY=ENC[...]\nsops_version=3.13.3\n",
    });

    await SopsService.encrypt(inputPath, outputPath);

    expect(execMock).toHaveBeenCalledWith(
      "sops",
      [...DOTENV_FLAGS, "--encrypt", inputPath],
      { silent: true }
    );
    await expect(readFile(outputPath, "utf-8")).resolves.toBe(
      "KEY=ENC[...]\nsops_version=3.13.3\n"
    );
  });

  // A fresh --encrypt re-keys every line, so a one-value change to a
  // committed .enc showed up as a whole-file diff. sops edit keeps
  // unchanged ciphertext; the plaintext is copied in as "the edit".
  it("encrypt applies the plaintext through sops edit when the output is already encrypted", async () => {
    const inputPath = path.join(dir, ".env.staging");
    const outputPath = path.join(dir, ".env.staging.enc");
    const existing = "KEY=ENC[old]\nsops_mac=ENC[mac]\nsops_version=3.13.3\n";
    await writeFile(inputPath, 'KEY="value"\n');
    await writeFile(outputPath, existing);
    execMock.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await SopsService.encrypt(inputPath, outputPath);

    expect(execMock).toHaveBeenCalledWith(
      "sops",
      ["edit", ...DOTENV_FLAGS, outputPath],
      { env: { EDITOR: `cp "${inputPath}"` }, silent: true }
    );
    // sops writes the file itself; empty stdout must not clobber it.
    await expect(readFile(outputPath, "utf-8")).resolves.toBe(existing);
  });

  // sops shell-splits EDITOR, so an unquoted path with a space would become
  // two cp operands and the edit would fail before touching the file.
  it("encrypt quotes the plaintext path in EDITOR so a space survives sops's word split", async () => {
    const spacedDir = path.join(dir, "with space");
    await mkdir(spacedDir);
    const inputPath = path.join(spacedDir, ".env.staging");
    const outputPath = path.join(spacedDir, ".env.staging.enc");
    await writeFile(inputPath, 'KEY="value"\n');
    await writeFile(
      outputPath,
      "KEY=ENC[old]\nsops_mac=ENC[mac]\nsops_version=3.13.3\n"
    );
    execMock.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await SopsService.encrypt(inputPath, outputPath);

    expect(execMock).toHaveBeenCalledWith(
      "sops",
      ["edit", ...DOTENV_FLAGS, outputPath],
      { env: { EDITOR: `cp "${inputPath}"` }, silent: true }
    );
  });

  it("encrypt treats sops edit's 'file has not changed' exit as a no-op", async () => {
    const inputPath = path.join(dir, ".env.staging");
    const outputPath = path.join(dir, ".env.staging.enc");
    await writeFile(inputPath, 'KEY="value"\n');
    await writeFile(
      outputPath,
      "KEY=ENC[old]\nsops_mac=ENC[mac]\nsops_version=3.13.3\n"
    );
    execMock.mockRejectedValue(
      new Error(
        "Command failed with exit code 200: File has not changed, exiting."
      )
    );

    await expect(
      SopsService.encrypt(inputPath, outputPath)
    ).resolves.toBeUndefined();
  });

  it("encrypt via sops edit still keeps sops's error out of the message", async () => {
    const inputPath = path.join(dir, ".env.staging");
    const outputPath = path.join(dir, ".env.staging.enc");
    await writeFile(inputPath, 'SECRET="super-secret-value"\n');
    await writeFile(
      outputPath,
      "SECRET=ENC[old]\nsops_mac=ENC[mac]\nsops_version=3.13.3\n"
    );
    execMock.mockRejectedValue(
      new Error(
        'Command failed with exit code 1: bad line SECRET="super-secret-value"'
      )
    );

    await expect(
      SopsService.encrypt(inputPath, outputPath)
    ).rejects.toMatchObject({
      code: "ENCRYPT_FAILED",
      message: expect.not.stringContaining("super-secret-value"),
    });
  });
});

describe("SopsService.isEncrypted", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sops-service-test-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("detects sops metadata in unquoted (e.g. YAML) form", async () => {
    const filePath = path.join(dir, "legacy.enc");
    await writeFile(
      filePath,
      "data: ENC[AES256_GCM,data:...]\nsops:\n    version: 3.13.3\n"
    );

    await expect(SopsService.isEncrypted(filePath)).resolves.toBe(true);
  });

  it("detects the dotenv format, which flattens metadata into sops_version=", async () => {
    const filePath = path.join(dir, "dotenv.enc");
    await writeFile(
      filePath,
      [
        "DATABASE_URL=ENC[AES256_GCM,data:...,type:str]",
        "sops_lastmodified=2026-09-15T17:16:01Z",
        "sops_mac=ENC[AES256_GCM,data:...,type:str]",
        "sops_version=3.13.3",
      ].join("\n")
    );

    await expect(SopsService.isEncrypted(filePath)).resolves.toBe(true);
  });

  // encrypt() routes on this: a plaintext that only mentions the version
  // must take the full-encrypt path, not be handed to `sops edit`.
  it("does not treat a dotenv with sops_version but no sops_mac as encrypted", async () => {
    const filePath = path.join(dir, "half.env");
    await writeFile(
      filePath,
      'DATABASE_URL="postgres://example"\nsops_version=3.13.3\n'
    );

    await expect(SopsService.isEncrypted(filePath)).resolves.toBe(false);
  });

  it("returns false for plain, unencrypted dotenv content", async () => {
    const filePath = path.join(dir, "plain.env");
    await writeFile(filePath, 'DATABASE_URL="postgres://example"\n');

    await expect(SopsService.isEncrypted(filePath)).resolves.toBe(false);
  });

  it("returns false when the file doesn't exist", async () => {
    await expect(
      SopsService.isEncrypted(path.join(dir, "missing.enc"))
    ).resolves.toBe(false);
  });
});
