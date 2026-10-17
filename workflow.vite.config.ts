import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite";

const nodeBuiltins = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
);

export default defineConfig({
  resolve: {
    conditions: ["node"],
  },
  build: {
    target: "node24",
    minify: false,
    outDir: resolve(import.meta.dirname, "artifacts/workflow/runtime"),
    emptyOutDir: true,
    sourcemap: true,
    assetsInlineLimit: 0,
    lib: {
      entry: resolve(import.meta.dirname, "src/cli/workflow-entrypoint.ts"),
      formats: ["es"],
      fileName: () => "tracker-run.mjs",
    },
    rollupOptions: {
      external: (source) => nodeBuiltins.has(source),
    },
  },
});
