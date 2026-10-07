export const SOURCE_LINE_CHECKER_VERSION = 3;

export const SOURCE_LINE_ROOTS = [
  "src",
  "web/src",
  ".github/actions",
  ".github/scripts",
  ".github/workflows",
  "scripts",
  "config",
];

export const SOURCE_LINE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".sh",
  ".css",
  ".vue",
  ".py",
  ".yml",
  ".yaml",
];

export const SOURCE_LINE_ESLINT_GLOBS = [
  "src/**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}",
  "web/src/**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}",
  ".github/actions/**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}",
  ".github/scripts/**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}",
  "scripts/**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}",
  "config/**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}",
];

export const SOURCE_LINE_PERMANENT_EXCLUSIONS = [
  "artifacts/workflow/runtime/**",
  "coverage/**",
  "dist/**",
  "fixtures/**",
  "node_modules/**",
  "src/generated/**",
  "web/public/data/**",
  "web/src/generated/**",
  "web/src/mock-data/**",
  ".github/scripts/generated/**",
];

/** 恒久例外のpathかを判定する。 */
export function isSourceLineExcluded(path) {
  return SOURCE_LINE_PERMANENT_EXCLUSIONS.some((pattern) => path.startsWith(pattern.slice(0, -2)));
}
