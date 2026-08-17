import eslint from "@eslint/js";
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
    files: ["**/*.{cts,mts,ts}"],
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
]);
