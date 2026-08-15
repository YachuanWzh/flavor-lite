import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: false,
  clean: true,
  // dts is skipped: tsup's dts bundling is not compatible with typescript 7.
  // Run `npm run types` (tsc --emitDeclarationOnly) when declarations are needed.
  dts: false,
  splitting: false,
});
