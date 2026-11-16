import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getEnvDir } from "../constants/paths";
import {
  createCopyVariable,
  createReadDefinitions,
  createWriteToClipboard,
  maskValue,
} from "./copy";
import type { VariableDefinition } from "./copy";

const API_VALUE = "fixture-api-value-0123456789";
const SHARED_VALUE = "fixture-shared-value-9876543210";

describe(maskValue, () => {
  // The preview exists to recognise a value, not to leak it.
  it("reveals at most the first four characters of a long value", () => {
    const masked = maskValue(API_VALUE);
    expect(masked).toBe(`fixt… (${API_VALUE.length} chars)`);
    expect(masked).not.toContain(API_VALUE.slice(0, 5));
  });

  // Four characters of an eight-character password is half of it.
  it("reveals nothing of a short value", () => {
    const masked = maskValue("hunter22");
    expect(masked).toBe("… (8 chars)");
    expect(masked).not.toContain("hunt");
  });
});

describe(createReadDefinitions, () => {
  it("records shared/ scope so the picker can say which targets see it", async () => {
    const sharedPath = path.join(getEnvDir(), "shared", ".env.production.enc");
    const apiPath = path.join(getEnvDir(), "api", ".env.production.enc");

    const contents = new Map([
      [apiPath, `STRIPE_KEY="${API_VALUE}"`],
      [sharedPath, `# @apps: api, web\nSTRIPE_KEY="${SHARED_VALUE}"`],
    ]);

    const readDefinitions = createReadDefinitions({
      decrypt: (encPath) => Promise.resolve(contents.get(encPath) ?? ""),
      directories: () => Promise.resolve(["shared", "api", "web"]),
      fileExists: (filePath) => Promise.resolve(contents.has(filePath)),
    });

    const definitions = await readDefinitions("production");

    expect(definitions.get("STRIPE_KEY")).toStrictEqual([
      {
        directory: "shared",
        key: "STRIPE_KEY",
        scope: ["api", "web"],
        value: SHARED_VALUE,
      },
      { directory: "api", key: "STRIPE_KEY", value: API_VALUE },
    ]);
  });
});

const shared: VariableDefinition = {
  directory: "shared",
  key: "STRIPE_KEY",
  scope: ["api", "web"],
  value: SHARED_VALUE,
};

const apiOverride: VariableDefinition = {
  directory: "api",
  key: "STRIPE_KEY",
  value: API_VALUE,
};

const setupCopy = () => {
  const chooseDefinition =
    vi.fn<(definitions: VariableDefinition[]) => Promise<VariableDefinition>>();

  const writeToClipboard = vi.fn<(value: string) => Promise<void>>(() =>
    Promise.resolve()
  );

  const copyVariable = createCopyVariable({
    chooseDefinition,
    writeToClipboard,
  });

  return { chooseDefinition, copyVariable, writeToClipboard };
};

describe(createCopyVariable, () => {
  // Silently picking one would hand over the wrong secret with no warning.
  it("asks which one when the key holds different values per target", async () => {
    const { chooseDefinition, copyVariable, writeToClipboard } = setupCopy();
    chooseDefinition.mockResolvedValue(apiOverride);

    await copyVariable({
      definitions: [shared, apiOverride],
      key: "STRIPE_KEY",
    });

    expect(chooseDefinition).toHaveBeenCalledWith([shared, apiOverride]);
    expect(writeToClipboard).toHaveBeenCalledWith(API_VALUE);
  });

  it("doesn't ask when every copy holds the same value", async () => {
    const { chooseDefinition, copyVariable, writeToClipboard } = setupCopy();

    await copyVariable({
      definitions: [shared, { ...apiOverride, value: SHARED_VALUE }],
      key: "STRIPE_KEY",
    });

    expect(chooseDefinition).not.toHaveBeenCalled();
    expect(writeToClipboard).toHaveBeenCalledWith(SHARED_VALUE);
  });

  // The app's own file overrides shared/ at merge time, so that's what it runs with.
  it("copies the value a --target actually sees", async () => {
    const { chooseDefinition, copyVariable, writeToClipboard } = setupCopy();

    await copyVariable({
      definitions: [shared, apiOverride],
      key: "STRIPE_KEY",
      target: "api",
    });
    await copyVariable({
      definitions: [shared, apiOverride],
      key: "STRIPE_KEY",
      target: "web",
    });

    expect(chooseDefinition).not.toHaveBeenCalled();
    expect(writeToClipboard.mock.calls).toStrictEqual([
      [API_VALUE],
      [SHARED_VALUE],
    ]);
  });

  it("refuses a target the shared tag doesn't include", async () => {
    const { copyVariable, writeToClipboard } = setupCopy();

    await expect(
      copyVariable({ definitions: [shared], key: "STRIPE_KEY", target: "cms" })
    ).rejects.toThrow("STRIPE_KEY is not visible to cms.");
    expect(writeToClipboard).not.toHaveBeenCalled();
  });

  // Anything on stdout ends up in terminal scrollback and CI logs.
  it("never prints the value", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(vi.fn());
    const error = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const { chooseDefinition, copyVariable } = setupCopy();
    chooseDefinition.mockResolvedValue(apiOverride);

    await copyVariable({
      definitions: [shared, apiOverride],
      key: "STRIPE_KEY",
    });

    const printed = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
    log.mockRestore();
    error.mockRestore();
    expect(printed).not.toContain(API_VALUE);
  });
});

type PipeToCommand = Parameters<
  typeof createWriteToClipboard
>[0]["pipeToCommand"];

describe(createWriteToClipboard, () => {
  // argv is visible to every user on the machine through `ps`; stdin isn't.
  it("hands the value to the clipboard tool on stdin, not in its arguments", async () => {
    const pipeToCommand = vi.fn<PipeToCommand>(() => Promise.resolve());

    const writeToClipboard = createWriteToClipboard({
      commandExists: (command) => command === "xclip",
      pipeToCommand,
      platform: "linux",
    });

    await writeToClipboard(API_VALUE);

    expect(pipeToCommand).toHaveBeenCalledWith({
      args: ["-selection", "clipboard"],
      command: "xclip",
      input: API_VALUE,
    });
  });

  it("names the tools to install when none is on PATH", async () => {
    const pipeToCommand = vi.fn<PipeToCommand>(() => Promise.resolve());

    const writeToClipboard = createWriteToClipboard({
      commandExists: () => false,
      pipeToCommand,
      platform: "linux",
    });

    await expect(writeToClipboard(API_VALUE)).rejects.toThrow(
      "No clipboard tool found. Install one of: wl-copy, xclip, xsel."
    );
    expect(pipeToCommand).not.toHaveBeenCalled();
  });
});
