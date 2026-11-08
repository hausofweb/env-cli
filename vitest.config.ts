import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/testing/setup.ts"],
  },
});
