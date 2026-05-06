import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: ["posthog-node", "posthog-node/edge"],
  },
  dts: true,
  entry: ["src/index.ts"],
  fixedExtension: true,
  format: ["esm", "cjs"],
  sourcemap: true,
});
