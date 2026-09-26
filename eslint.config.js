import eslint from "@eslint/js";
import { builtinModules } from "node:module";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

const productionRuntimeStageDirectories = [
  "ai-dependencies",
  "daily-startup",
  "collection",
  "deterministic",
  "codex",
  "reduction",
  "graph",
  "personal-reminder",
  "validation",
  "publication",
  "workflow",
];

export default defineConfig([
  {
    ignores: ["artifacts/workflow/runtime/**", "coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{cjs,js,mjs}"],
    extends: [eslint.configs.recommended, eslintConfigPrettier],
  },
  {
    files: ["**/*.{cts,mts,ts,tsx}"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      eslintConfigPrettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "never",
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "BinaryExpression[operator='==='] > Literal[value=null]",
          message: "nullとの比較には==を使ってください",
        },
        {
          selector: "BinaryExpression[operator='!=='] > Literal[value=null]",
          message: "nullとの比較には!=を使ってください",
        },
        {
          selector: "BinaryExpression[operator='==='] > Identifier[name='undefined']",
          message: "nullまたはundefinedとの比較には== nullを使ってください",
        },
        {
          selector: "BinaryExpression[operator='!=='] > Identifier[name='undefined']",
          message: "nullまたはundefinedとの比較には!= nullを使ってください",
        },
      ],
    },
  },
  {
    files: ["src/cli/initial-item-analysis.ts"],
    rules: {
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "**/production-runtime*",
                "**/composition-root*",
                "**/daily-transaction*",
                "**/persistence/**",
                "**/config/**",
                "**/codex/**",
                "**/discord/**",
                "**/pages/**",
              ],
              message: "初期判定には、実行環境や副作用ではなく解決済みの値を渡してください",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "初期判定では外部接続を行わないでください" },
        { name: "process", message: "初期判定では実行環境を参照しないでください" },
      ],
    },
  },
  {
    files: ["src/cli/personal-reminder/**/*.ts"],
    rules: {
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules
            .filter((moduleName) => !moduleName.startsWith("node:"))
            .map((name) => ({
              name,
              message: "個人催促の解析はNode.jsの組み込みモジュールを参照しないでください",
            })),
          patterns: [
            {
              group: [
                "node:*",
                "**/production-runtime*",
                "**/persistence/**",
                "**/pages/**",
                "**/discord/**",
                "./index",
                "./index.*",
                "../personal-reminder/index",
                "../personal-reminder/index.*",
              ],
              message:
                "個人催促の解析は実行環境や副作用を参照せず、実装間は所有元を直接参照してください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cli/production-runtime.ts"],
    rules: {
      "max-lines": ["error", { max: 150, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    files: ["src/cli/production-runtime/**/*.ts"],
    rules: {
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    files: ["src/cli/production-runtime/**/*.ts"],
    ignores: [
      "src/cli/production-runtime/adapters.ts",
      "src/cli/production-runtime/clock.ts",
      "src/cli/production-runtime/contracts.ts",
      "src/cli/production-runtime/create-application.ts",
      "src/cli/production-runtime/daily-dependencies.ts",
      "src/cli/production-runtime/previous-state/**/*.ts",
      "src/cli/production-runtime/workflow/create-runner.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "fs",
            "fs/promises",
            "child_process",
            "node:fs",
            "node:fs/promises",
            "node:child_process",
          ].map((name) => ({
            name,
            message: "段階実装ではファイルシステムや子プロセスを直接使わないでください",
          })),
          patterns: [
            {
              group: [
                "**/production-runtime",
                "**/production-runtime.js",
                "**/production-runtime.ts",
                "**/create-application",
                "**/create-application.js",
                "**/create-application.ts",
                "**/daily-dependencies",
                "**/daily-dependencies.js",
                "**/daily-dependencies.ts",
                "**/workflow/create-runner",
                "**/workflow/create-runner.js",
                "**/workflow/create-runner.ts",
                "./create-runner",
                "./create-runner.js",
                "./create-runner.ts",
              ],
              message: "段階実装から公開ファサードや実行組み立てを参照しないでください",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "段階実装ではglobal fetchを使わないでください" },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "段階実装ではprocess.envを参照しないでください",
        },
      ],
    },
  },
  {
    files: [
      "src/cli/production-runtime/adapters.ts",
      "src/cli/production-runtime/clock.ts",
      "src/cli/production-runtime/contracts.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: productionRuntimeStageDirectories.map((directory) => `./${directory}/**`),
              message: "横断契約から段階実装を参照しないでください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cli/production-runtime/previous-state/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: productionRuntimeStageDirectories.map((directory) => `../${directory}/**`),
              message: "前回状態から段階実装を参照しないでください",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/cli/run-publication/**/*.ts"],
    rules: {
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/production-runtime",
                "**/production-runtime.js",
                "**/production-runtime.ts",
                "**/production-runtime/**",
              ],
              message: "公開処理からproduction-runtimeを参照しないでください",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "公開処理ではglobal fetchを使わないでください" },
        { name: "process", message: "公開処理ではglobal processを使わないでください" },
      ],
    },
  },
]);
