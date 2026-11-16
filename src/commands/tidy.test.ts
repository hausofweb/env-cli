import { describe, expect, it } from "vitest";

import type { AppConfig } from "../types/app-config.types";
import { misplacedTarget } from "./tidy";

const api: AppConfig = { directory: "apps/api", name: "api", type: "vercel" };

const infra: AppConfig = {
  directory: "apps/infra",
  name: "infra",
  type: "non-vercel",
};

const web: AppConfig = { directory: "apps/web", name: "web", type: "vercel" };
const allApps = [api, infra, web];

const shared = (directive: string) =>
  [directive, "# SecureString", 'NEON_API_KEY="napi_x"', ""].join("\n");

describe(misplacedTarget, () => {
  it("moves a shared/ variable tagged for one app to that app", () => {
    expect(
      misplacedTarget({
        allApps,
        key: "NEON_API_KEY",
        otherDirectories: [],
        sharedContent: shared("# @apps: api"),
      })
    ).toBe("api");
  });

  // Moving it would hide it from every app but one.
  it("leaves a variable several apps see in shared/", () => {
    expect(
      misplacedTarget({
        allApps,
        key: "NEON_API_KEY",
        otherDirectories: [],
        sharedContent: shared("# @apps: api, infra"),
      })
    ).toBeUndefined();
    expect(
      misplacedTarget({
        allApps,
        key: "NEON_API_KEY",
        otherDirectories: [],
        sharedContent: shared("# @global"),
      })
    ).toBeUndefined();
  });

  // A copy in web/ means web sees it too, so shared/ is still its home.
  it("counts a copy in another app's folder as a second audience", () => {
    expect(
      misplacedTarget({
        allApps,
        key: "NEON_API_KEY",
        otherDirectories: ["web"],
        sharedContent: shared("# @apps: api"),
      })
    ).toBeUndefined();
  });

  it("still moves it when the copy is in the same app's folder", () => {
    expect(
      misplacedTarget({
        allApps,
        key: "NEON_API_KEY",
        otherDirectories: ["api"],
        sharedContent: shared("# @apps: api"),
      })
    ).toBe("api");
  });
});
