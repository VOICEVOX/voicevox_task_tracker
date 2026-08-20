import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

import { loadWebConfig } from "../src/config/index.js";

const webConfig = await loadWebConfig(new URL("../config.yml", import.meta.url));
const outputDirectory = resolve(import.meta.dirname, "../dist/web");
const staticPagePaths = ["items", "people", "guide"];

function createGitHubPagesFallbackPlugin(): Plugin {
  return {
    name: "github-pages-fallback",
    apply: "build",
    async closeBundle() {
      const indexPath = resolve(outputDirectory, "index.html");
      await Promise.all([
        copyFile(indexPath, resolve(outputDirectory, "404.html")),
        ...staticPagePaths.map(async (staticPath) => {
          const staticPageDirectory = resolve(outputDirectory, staticPath);
          await mkdir(staticPageDirectory, {
            recursive: true,
          });
          await copyFile(indexPath, resolve(staticPageDirectory, "index.html"));
        }),
      ]);
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  base: webConfig.basePath,
  plugins: [tailwindcss(), preact(), createGitHubPagesFallbackPlugin()],
  publicDir: "public",
  define: {
    __VOICEVOX_TRACKER_LOCALE__: JSON.stringify(webConfig.defaultLocale),
    __VOICEVOX_TRACKER_TITLE__: JSON.stringify(webConfig.title),
  },
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
  },
});
