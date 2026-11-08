import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: { bin: "src/bin.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
});
