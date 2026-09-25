import eslint from "@eslint/js";
import { builtinModules } from "node:module";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

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
]);
