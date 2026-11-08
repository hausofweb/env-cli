import type { confirm as inquirerConfirm } from "@inquirer/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VercelExistingVariable } from "../services/vercel.service";
import type { Environment } from "../types/app-config.types";
import { output } from "../utils/cli-output";
import {
  buildAppVariables,
  createPruneAppEnvironment,
  findPruneCandidates,
} from "./sync-vercel";

const confirm = vi.fn<typeof inquirerConfirm>();
const pruneAppEnvironment = createPruneAppEnvironment({ confirm });

const SHARED = [
  "GLOBAL_KEY=one",
  "# @apps: api",
  "API_ONLY=two",
  "# @apps: web, app",
  "WEB_AND_APP=three",
  "# @global",
  "ALSO_GLOBAL=four",
].join("\n");

const variable = (
  key: string,
  extra: Partial<VercelExistingVariable> = {}
): VercelExistingVariable => ({
  customEnvironmentIds: [],
  id: `id-${key}`,
  isManaged: false,
  key,
  targets: ["production"],
  value: "",
  ...extra,
});

const expectedKeysFor = (appName: string, appContent = ""): Set<string> =>
  new Set(
    buildAppVariables({ appContent, appName, sharedContent: SHARED }).map(
      ({ key }) => key
    )
  );

const fakeVercel = (existing: VercelExistingVariable[]) => ({
  getEnvironmentVariables: vi.fn<() => Promise<VercelExistingVariable[]>>(() =>
    Promise.resolve(existing)
  ),
  removeFromEnvironment: vi.fn<
    (
      variable: VercelExistingVariable,
      environment: Environment
    ) => Promise<"narrowed" | "removed">
  >(() => Promise.resolve("removed")),
});

describe(buildAppVariables, () => {
  it("gives each app global shared vars, the shared vars scoped to it, and its own file", () => {
    expect(expectedKeysFor("api", "API_OWN=x")).toStrictEqual(
      new Set(["GLOBAL_KEY", "API_ONLY", "ALSO_GLOBAL", "API_OWN"])
    );
    expect(expectedKeysFor("web")).toStrictEqual(
      new Set(["GLOBAL_KEY", "WEB_AND_APP", "ALSO_GLOBAL"])
    );
  });
});

describe(findPruneCandidates, () => {
  it("never prunes integration-managed or Vercel system variables, even when no file defines them", () => {
    const candidates = findPruneCandidates({
      existing: [
        variable("STALE"),
        variable("POSTGRES_URL", { isManaged: true }),
        variable("VERCEL_URL"),
      ],
      expectedKeys: new Set(),
    });

    expect(candidates.map(({ key }) => key)).toStrictEqual(["STALE"]);
  });

  it("never prunes a per-branch preview override, which is set on purpose outside the files", () => {
    const candidates = findPruneCandidates({
      existing: [variable("OVERRIDE", { gitBranch: "feature-x" })],
      expectedKeys: new Set(),
    });

    expect(candidates).toStrictEqual([]);
  });

  it("keeps a key scoped to app A on app A but prunes it from app B", () => {
    const onEachProject = [variable("API_ONLY"), variable("GLOBAL_KEY")];

    const fromApi = findPruneCandidates({
      existing: onEachProject,
      expectedKeys: expectedKeysFor("api"),
    });

    const fromWeb = findPruneCandidates({
      existing: onEachProject,
      expectedKeys: expectedKeysFor("web"),
    });

    expect(fromApi).toStrictEqual([]);
    expect(fromWeb.map(({ key }) => key)).toStrictEqual(["API_ONLY"]);
  });
});

describe("pruneAppEnvironment on externally managed keys", () => {
  beforeEach(() => {
    for (const method of ["info", "warning", "success"] as const) {
      vi.spyOn(output, method).mockReturnValue(undefined);
    }
  });

  it("never deletes the Sentry keys listed in externallyManagedKeys, while still pruning a stale key", async () => {
    confirm.mockResolvedValue(true);
    const stale = variable("STALE");

    const vercel = fakeVercel([
      variable("NEXT_PUBLIC_SENTRY_DSN"),
      variable("SENTRY_AUTH_TOKEN"),
      stale,
    ]);

    const pruned = await pruneAppEnvironment({
      environment: "production",
      expectedKeys: new Set(),
      label: "web/production",
      shouldApply: true,
      vercelService: vercel,
    });

    expect(pruned).toBe(1);
    expect(vercel.removeFromEnvironment.mock.calls).toStrictEqual([
      [stale, "production"],
    ]);
  });
});

describe("pruneAppEnvironment", () => {
  beforeEach(() => {
    confirm.mockReset();

    for (const method of ["info", "warning", "success"] as const) {
      vi.spyOn(output, method).mockReturnValue(undefined);
    }
  });

  it("deletes nothing and never prompts on a report-only run", async () => {
    const vercel = fakeVercel([variable("STALE")]);

    const pruned = await pruneAppEnvironment({
      environment: "production",
      expectedKeys: new Set(),
      label: "web/production",
      shouldApply: false,
      vercelService: vercel,
    });

    expect(pruned).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(vercel.removeFromEnvironment).not.toHaveBeenCalled();
    expect(output.warning).toHaveBeenCalledWith(
      "  web/production: would remove STALE"
    );
  });

  it("deletes nothing when the confirm prompt is declined", async () => {
    confirm.mockResolvedValue(false);
    const vercel = fakeVercel([variable("STALE")]);

    await pruneAppEnvironment({
      environment: "production",
      expectedKeys: new Set(),
      label: "web/production",
      shouldApply: true,
      vercelService: vercel,
    });

    expect(vercel.removeFromEnvironment).not.toHaveBeenCalled();
  });

  it("on confirm, takes every stale variable out of this environment only, including ones shared with other environments", async () => {
    confirm.mockResolvedValue(true);
    const stale = variable("STALE");

    const staleShared = variable("STALE_SHARED", {
      targets: ["production", "preview"],
    });

    const vercel = fakeVercel([stale, staleShared, variable("GLOBAL_KEY")]);

    const pruned = await pruneAppEnvironment({
      environment: "production",
      expectedKeys: expectedKeysFor("web"),
      label: "web/production",
      shouldApply: true,
      vercelService: vercel,
    });

    expect(pruned).toBe(2);
    expect(vercel.removeFromEnvironment.mock.calls).toStrictEqual([
      [stale, "production"],
      [staleShared, "production"],
    ]);
    expect(output.warning).toHaveBeenCalledWith(
      "  web/production: would remove STALE_SHARED (narrowed; stays on 1 other environment(s))"
    );
  });
});
