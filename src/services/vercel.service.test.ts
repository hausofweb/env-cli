import type { Vercel } from "@vercel/sdk";
import { describe, expect, it, vi } from "vitest";

import { fakeOf } from "../testing/fake";
import { output } from "../utils/cli-output";
import {
  buildSyncComment,
  extractSyncedHash,
  hashValue,
  needsTypeRecreate,
  SYNC_HASH_PREFIX,
  VercelService,
} from "./vercel.service";

const STAGING_ID = "env_staging";

/** The optional fields of a filterProjectEnvs entry these tests vary. */
interface RawEnvExtra {
  /** Sync hash comment. */
  comment?: string;
  /** Integration ownership. */
  configurationId?: string;
  /** Custom environments the variable serves. */
  customEnvironmentIds?: string[];
  /** Edge Config ownership. */
  edgeConfigId?: string;
  /** Edge Config token ownership. */
  edgeConfigTokenId?: string;
  /** Per-branch preview override. */
  gitBranch?: string;
  /** Vercel's findings, e.g. the one that marks a Flags secret. */
  securityIssues?: string[];
  /** Vercel-provided variable. */
  system?: boolean;
  /** Classic targets the variable serves. */
  target?: string[];
}

/** Shaped like Vercel's filterProjectEnvs response, not like our mapping. */
const rawEnv = (key: string, extra: RawEnvExtra = {}) => ({
  id: `id-${key}`,
  key,
  securityIssues: [],
  target: ["production"],
  type: "encrypted",
  value: "",
  ...extra,
});

type EditProjectEnvRequest = Parameters<
  Vercel["projects"]["editProjectEnv"]
>[0];

type RemoveProjectEnvRequest = Parameters<
  Vercel["projects"]["removeProjectEnv"]
>[0];

const serviceWith = (envs: ReturnType<typeof rawEnv>[]) => {
  const projects = {
    editProjectEnv: vi.fn<(request: EditProjectEnvRequest) => Promise<object>>(
      () => Promise.resolve({})
    ),
    filterProjectEnvs: vi.fn<
      () => Promise<{
        envs: ReturnType<typeof rawEnv>[];
        hiddenProductionEnvCount: number;
      }>
    >(() => Promise.resolve({ envs, hiddenProductionEnvCount: 0 })),
    removeProjectEnv: vi.fn<
      (request: RemoveProjectEnvRequest) => Promise<object>
    >(() => Promise.resolve({})),
  };

  const environment = {
    getProjectsByIdOrNameCustomEnvironments: vi.fn<
      () => Promise<{ environments: { id: string; slug: string }[] }>
    >(() =>
      Promise.resolve({ environments: [{ id: STAGING_ID, slug: "staging" }] })
    ),
  };

  const service = new VercelService(
    fakeOf<Vercel>()({ environment, projects })
  );

  service.useProject({ projectId: "prj_1" });

  return { projects, service };
};

describe("getEnvironmentVariables mapping from a raw Vercel payload", () => {
  it("marks every integration- and Vercel-owned variable as managed, so a prune can never touch them", async () => {
    const { service } = serviceWith([
      rawEnv("MINE"),
      rawEnv("INTEGRATION", { configurationId: "icfg_1" }),
      rawEnv("EDGE", { edgeConfigId: "ecfg_1" }),
      rawEnv("EDGE_TOKEN", { edgeConfigTokenId: "tok_1" }),
      rawEnv("FLAGS", { securityIssues: ["flags-secret-needs-split"] }),
      rawEnv("SYSTEM", { system: true }),
    ]);

    const variables = await service.getEnvironmentVariables("production");

    const managed = Object.fromEntries(
      variables.map(({ key, isManaged }) => [key, isManaged])
    );

    expect(managed).toStrictEqual({
      EDGE: true,
      EDGE_TOKEN: true,
      FLAGS: true,
      INTEGRATION: true,
      MINE: false,
      SYSTEM: true,
    });
  });

  it("carries every target, custom environment and branch a variable has", async () => {
    const { service } = serviceWith([
      rawEnv("SHARED", {
        customEnvironmentIds: [STAGING_ID],
        gitBranch: "feature-x",
        target: ["production", "preview"],
      }),
    ]);

    const [variable] = await service.getEnvironmentVariables("production");

    expect(variable).toMatchObject({
      customEnvironmentIds: [STAGING_ID],
      gitBranch: "feature-x",
      targets: ["production", "preview"],
    });
  });
});

describe("removeFromEnvironment", () => {
  it("narrows a variable that serves other environments, sending no value so they keep theirs", async () => {
    const { projects, service } = serviceWith([
      rawEnv("STALE", {
        customEnvironmentIds: [STAGING_ID],
        target: ["production", "preview"],
      }),
    ]);

    const [variable] = await service.getEnvironmentVariables("staging");

    const outcome = await service.removeFromEnvironment(variable, "staging");

    expect(outcome).toBe("narrowed");
    expect(projects.removeProjectEnv).not.toHaveBeenCalled();
    expect(projects.editProjectEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: {
          customEnvironmentIds: [],
          target: ["production", "preview"],
        },
      })
    );
  });

  it("deletes a variable only once this environment was its last", async () => {
    const { projects, service } = serviceWith([rawEnv("STALE")]);
    const [variable] = await service.getEnvironmentVariables("production");

    const outcome = await service.removeFromEnvironment(variable, "production");

    expect(outcome).toBe("removed");
    expect(projects.editProjectEnv).not.toHaveBeenCalled();
    expect(projects.removeProjectEnv).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id-STALE" })
    );
  });
});

type CreateProjectEnvRequest = Parameters<
  Vercel["projects"]["createProjectEnv"]
>[0];

/** One variable as the stateful fake stores it. */
interface StoredEnv {
  comment?: string;
  customEnvironmentIds: string[];
  id: string;
  key: string;
  securityIssues: string[];
  target: string[];
  type: string;
  value: string;
}

/** A project whose env list reflects every create, edit and remove, like Vercel's. */
const statefulServiceWith = (initial: ReturnType<typeof rawEnv>[]) => {
  let envs: StoredEnv[] = initial.map((env) => ({
    comment: env.comment,
    customEnvironmentIds: env.customEnvironmentIds ?? [],
    id: env.id,
    key: env.key,
    securityIssues: env.securityIssues,
    target: env.target,
    type: env.type,
    value: env.value,
  }));

  let nextID = 0;

  const projects = {
    createProjectEnv: vi.fn<
      (request: CreateProjectEnvRequest) => Promise<object>
    >((request) => {
      const body = request.requestBody;

      if (Array.isArray(body)) {
        throw new TypeError("batch create is not used by the sync");
      }

      nextID += 1;
      envs.push({
        comment: body.comment,
        customEnvironmentIds: body.customEnvironmentIds ?? [],
        id: `id-${body.key}-${nextID}`,
        key: body.key,
        securityIssues: [],
        target: Array.isArray(body.target) ? body.target : [],
        type: body.type,
        value: body.value,
      });

      return Promise.resolve({});
    }),
    editProjectEnv: vi.fn<(request: EditProjectEnvRequest) => Promise<object>>(
      ({ id, requestBody }) => {
        envs = envs.map((env) =>
          env.id === id
            ? {
                ...env,
                comment: requestBody.comment ?? env.comment,
                customEnvironmentIds:
                  requestBody.customEnvironmentIds ?? env.customEnvironmentIds,
                target: requestBody.target ?? env.target,
                type: requestBody.type ?? env.type,
                value: requestBody.value ?? env.value,
              }
            : env
        );

        return Promise.resolve({});
      }
    ),
    filterProjectEnvs: vi.fn<
      () => Promise<{ envs: StoredEnv[]; hiddenProductionEnvCount: number }>
    >(() => Promise.resolve({ envs, hiddenProductionEnvCount: 0 })),
    removeProjectEnv: vi.fn<
      (request: RemoveProjectEnvRequest) => Promise<object>
    >((request) => {
      envs = envs.filter((env) => env.id !== request.id);

      return Promise.resolve({});
    }),
  };

  const environment = {
    getProjectsByIdOrNameCustomEnvironments: vi.fn<
      () => Promise<{ environments: { id: string; slug: string }[] }>
    >(() =>
      Promise.resolve({ environments: [{ id: STAGING_ID, slug: "staging" }] })
    ),
  };

  const service = new VercelService(
    fakeOf<Vercel>()({ environment, projects })
  );

  service.useProject({ projectId: "prj_1" });

  const scopesByHash = () =>
    envs.map((env) => ({
      customEnvironmentIds: env.customEnvironmentIds,
      hash: extractSyncedHash(env.comment),
      target: env.target,
    }));

  return { projects, scopesByHash, service };
};

/** One production sync, then one preview sync, each with its own value. */
const syncProductionThenPreview = async (service: VercelService) => {
  const production = await service.syncEnvironmentVariables(
    [{ key: "SHARED", value: "production-value" }],
    "production"
  );

  const preview = await service.syncEnvironmentVariables(
    [{ key: "SHARED", value: "preview-value" }],
    "preview"
  );

  return { preview, production };
};

describe("syncEnvironmentVariables on a variable shared across environments", () => {
  it("splits it when two environments hold different values, so alternating syncs stop flipping it", async () => {
    const { scopesByHash, service } = statefulServiceWith([
      rawEnv("SHARED", {
        comment: buildSyncComment("preview-value"),
        target: ["production", "preview"],
      }),
    ]);

    await syncProductionThenPreview(service);
    const secondRound = await syncProductionThenPreview(service);

    expect(secondRound.production.skippedKeys).toStrictEqual(["SHARED"]);
    expect(secondRound.preview.skippedKeys).toStrictEqual(["SHARED"]);
    expect(scopesByHash()).toStrictEqual(
      expect.arrayContaining([
        {
          customEnvironmentIds: [],
          hash: hashValue("preview-value"),
          target: ["preview"],
        },
        {
          customEnvironmentIds: [],
          hash: hashValue("production-value"),
          target: ["production"],
        },
      ])
    );
    expect(scopesByHash()).toHaveLength(2);
  });

  it("leaves it shared when every environment holds the same value", async () => {
    const { projects, service } = statefulServiceWith([
      rawEnv("SHARED", {
        comment: buildSyncComment("same"),
        customEnvironmentIds: [STAGING_ID],
        target: ["production", "preview"],
      }),
    ]);

    const variables = [{ key: "SHARED", value: "same" }];
    await service.syncEnvironmentVariables(variables, "production");
    await service.syncEnvironmentVariables(variables, "preview");
    await service.syncEnvironmentVariables(variables, "staging");

    expect(projects.editProjectEnv).not.toHaveBeenCalled();
    expect(projects.createProjectEnv).not.toHaveBeenCalled();
    expect(projects.removeProjectEnv).not.toHaveBeenCalled();
  });

  it("gives this environment its own copy for a type change instead of deleting the shared one", async () => {
    const { projects, scopesByHash, service } = statefulServiceWith([
      rawEnv("SHARED", {
        comment: buildSyncComment("value"),
        target: ["production", "preview"],
      }),
    ]);

    const result = await service.syncEnvironmentVariables(
      [{ key: "SHARED", type: "SecureString", value: "value" }],
      "production"
    );

    expect(result.failed).toStrictEqual([]);
    expect(projects.removeProjectEnv).not.toHaveBeenCalled();
    expect(projects.createProjectEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          target: ["production"],
          type: "sensitive",
        }),
      })
    );
    expect(scopesByHash().map(({ target }) => target)).toStrictEqual([
      ["preview"],
      ["production"],
    ]);
  });
});

describe("syncEnvironmentVariables on externally managed keys", () => {
  it("never writes a key listed in externallyManagedKeys, even when the encrypted files still define it, while still syncing normal keys", async () => {
    vi.spyOn(output, "info").mockReturnValue(undefined);

    const { projects, scopesByHash, service } = statefulServiceWith([
      rawEnv("SENTRY_DSN", {
        comment: buildSyncComment("terraform-value"),
        target: ["production", "preview"],
      }),
    ]);

    const result = await service.syncEnvironmentVariables(
      [
        { key: "SENTRY_DSN", value: "sops-value" },
        { key: "NEXT_PUBLIC_SENTRY_DSN", value: "sops-value" },
        { key: "NORMAL", value: "value" },
      ],
      "production"
    );

    expect(result.addedKeys).toStrictEqual(["NORMAL"]);
    expect(projects.editProjectEnv).not.toHaveBeenCalled();
    expect(projects.removeProjectEnv).not.toHaveBeenCalled();
    expect(scopesByHash()).toContainEqual({
      customEnvironmentIds: [],
      hash: hashValue("terraform-value"),
      target: ["production", "preview"],
    });
    expect(output.info).toHaveBeenCalledWith(
      "  Skipped NEXT_PUBLIC_SENTRY_DSN: managed outside this CLI (externallyManagedKeys in env.config.json)"
    );
  });
});

describe("sync hash comment", () => {
  it("round-trips a value through buildSyncComment and extractSyncedHash", () => {
    const comment = buildSyncComment("sk_test_abc123");
    expect(comment).toBe(`${SYNC_HASH_PREFIX}${hashValue("sk_test_abc123")}`);
    expect(extractSyncedHash(comment)).toBe(hashValue("sk_test_abc123"));
  });

  it("produces different hashes for different values", () => {
    expect(hashValue("a")).not.toBe(hashValue("b"));
  });

  it("produces the same hash for the same value every time", () => {
    expect(hashValue("same")).toBe(hashValue("same"));
  });

  it("returns null for a comment with no prior sync hash", () => {
    // Covers the exact case this fix targets: a pre-existing Vercel
    // variable (e.g. type "sensitive") that was never synced by this
    // tool has no comment in our format, and must not be mistaken for a
    // match by accident.
    expect(extractSyncedHash(undefined)).toBeNull();
    expect(extractSyncedHash("")).toBeNull();
    expect(extractSyncedHash("used by the Stripe webhook")).toBeNull();
  });

  it("does not match a hash string that merely resembles the format", () => {
    expect(extractSyncedHash(`not-${SYNC_HASH_PREFIX}abc`)).toBeNull();
  });
});

describe(needsTypeRecreate, () => {
  it("requires recreate moving into sensitive", () => {
    expect(needsTypeRecreate("encrypted", "sensitive")).toBe(true);
  });

  it("requires recreate moving out of sensitive", () => {
    expect(needsTypeRecreate("sensitive", "encrypted")).toBe(true);
  });

  it("does not require recreate between non-sensitive types", () => {
    expect(needsTypeRecreate("plain", "encrypted")).toBe(false);
  });

  it("does not require recreate (and so never triggers a delete) when the current type is unrecognized", () => {
    // extractIfMatches produces vercelType: undefined for a Vercel `type`
    // this tool doesn't recognize. Since applyVariableUpdate only calls
    // removeEnvironmentVariable when needsTypeRecreate is true, this proves
    // an unrecognized current type never triggers a destructive delete.
    expect(needsTypeRecreate(undefined, "sensitive")).toBe(false);
  });
});

describe("VercelService.resolveProject", () => {
  it("uses app.config's project and team IDs for an app deployed from another repository", async () => {
    await expect(
      VercelService.resolveProject({
        vercelProjectId: "prj_documenso",
        vercelTeamId: "team_1",
      })
    ).resolves.toStrictEqual({ orgId: "team_1", projectId: "prj_documenso" });
  });

  it("treats an external app without a project ID as unlinked, so env sync skips it instead of failing", async () => {
    await expect(
      VercelService.resolveProject({ vercelTeamId: "team_1" })
    ).resolves.toBeNull();
  });
});
