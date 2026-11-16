import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildSsmPath,
  getAwsProfile,
  getEnvContext,
  getSsmParameterNames,
  hasSsmConfig,
  isExternallyManagedKey,
  setEnvContext,
} from "./config";
import type { EnvConfig } from "./config";
import { getEnvDir, getProjectRoot } from "./constants/paths";

describe("env.config.json discovery", () => {
  let repoRoot: string;

  const writeConfig = (config: unknown): Promise<void> =>
    writeFile(path.join(repoRoot, "env.config.json"), JSON.stringify(config));

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "env-cli-config-"));
    setEnvContext(undefined);
  });

  afterEach(async () => {
    await rm(repoRoot, { force: true, recursive: true });
  });

  it("walks up from a nested directory to the folder holding env.config.json", async () => {
    await writeConfig({});
    const nested = path.join(repoRoot, "apps", "web");
    await mkdir(nested, { recursive: true });

    const { root } = getEnvContext(nested);

    expect(root).toBe(repoRoot);
  });

  it("defaults envDir to env and leaves the optional sections unset", async () => {
    await writeConfig({});

    const { config } = getEnvContext(repoRoot);

    expect(config).toStrictEqual({ envDir: "env", externallyManagedKeys: [] });
    expect(getEnvDir()).toBe(path.join(repoRoot, "env"));
    expect(getProjectRoot()).toBe(repoRoot);
    expect(hasSsmConfig()).toBe(false);
  });

  it("resolves a custom envDir against the repo root", async () => {
    await writeConfig({ envDir: "apps/scripts/env" });
    getEnvContext(repoRoot);

    expect(getEnvDir()).toBe(path.join(repoRoot, "apps/scripts/env"));
  });

  it("names env.config.json when none exists above the start directory", () => {
    expect(() => getEnvContext(repoRoot)).toThrow(/env\.config\.json/u);
  });

  it("rejects a config whose fields have the wrong shape", async () => {
    await writeConfig({ ssm: { required: "DATABASE_URL" } });

    expect(() => getEnvContext(repoRoot)).toThrow(
      /Invalid .*env\.config\.json/u
    );
  });

  it("rejects a config that is not JSON", async () => {
    await writeFile(path.join(repoRoot, "env.config.json"), "{ nope");

    expect(() => getEnvContext(repoRoot)).toThrow(/Could not read/u);
  });

  it("reports the externally managed keys the file lists", async () => {
    await writeConfig({ externallyManagedKeys: ["SENTRY_AUTH_TOKEN"] });
    getEnvContext(repoRoot);

    expect(isExternallyManagedKey("SENTRY_AUTH_TOKEN")).toBe(true);
    expect(isExternallyManagedKey("DATABASE_URL")).toBe(false);
  });

  it("errors, naming the setting, when an environment has no AWS profile", async () => {
    await writeConfig({ awsProfiles: { development: "dev" } });
    getEnvContext(repoRoot);

    expect(getAwsProfile("development")).toBe("dev");
    expect(() => getAwsProfile("production")).toThrow("awsProfiles.production");
  });
});

describe(buildSsmPath, () => {
  it("namespaces the key under its environment", () => {
    expect(buildSsmPath({ environment: "staging", key: "DATABASE_URL" })).toBe(
      "/staging/DATABASE_URL"
    );
  });

  it("nests the environment under a project prefix", () => {
    expect(
      buildSsmPath({
        environment: "staging",
        key: "DATABASE_URL",
        prefix: "bpvs",
      })
    ).toBe("/bpvs/staging/DATABASE_URL");
  });
});

const useSsm = (ssm: Partial<NonNullable<EnvConfig["ssm"]>>): void =>
  setEnvContext({
    config: {
      envDir: "env",
      externallyManagedKeys: [],
      ssm: { optional: [], required: [], ...ssm },
    },
    root: "/repo",
  });

describe(getSsmParameterNames, () => {
  afterEach(() => setEnvContext(undefined));

  it("keeps the bare /<env>/<KEY> path for projects that set no prefix", () => {
    useSsm({});

    expect(
      getSsmParameterNames({ environment: "production", key: "DATABASE_URL" })
    ).toStrictEqual(["/production/DATABASE_URL"]);
  });

  it("ignores mirrorUnprefixedPaths without a prefix rather than writing the same path twice", () => {
    useSsm({ mirrorUnprefixedPaths: true });

    expect(
      getSsmParameterNames({ environment: "production", key: "DATABASE_URL" })
    ).toStrictEqual(["/production/DATABASE_URL"]);
  });

  it("puts the project path first and the legacy path second while mirroring", () => {
    useSsm({ mirrorUnprefixedPaths: true, pathPrefix: "bpvs" });

    expect(
      getSsmParameterNames({ environment: "production", key: "DATABASE_URL" })
    ).toStrictEqual([
      "/bpvs/production/DATABASE_URL",
      "/production/DATABASE_URL",
    ]);
  });
});

describe("ssm.pathPrefix validation", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "env-cli-config-"));
    setEnvContext(undefined);
  });

  afterEach(async () => {
    setEnvContext(undefined);
    await rm(repoRoot, { force: true, recursive: true });
  });

  it("rejects a prefix containing slashes, which would silently produce a different namespace", async () => {
    await writeFile(
      path.join(repoRoot, "env.config.json"),
      JSON.stringify({ ssm: { pathPrefix: "/bpvs" } })
    );

    expect(() => getEnvContext(repoRoot)).toThrow(/pathPrefix/u);
  });
});
