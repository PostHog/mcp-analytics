import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  fixedExtension: true,
  format: ["esm", "cjs"],
  sourcemap: true,
});
