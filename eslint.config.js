import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

const projectRules = {
  rules: {
    "no-type-assertion": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          forbidden: "型アサーションは禁止です。型注釈かsatisfiesを使ってください",
        },
      },
      create(context) {
        return {
          TSAsExpression(node) {
            context.report({ node, messageId: "forbidden" });
          },
          TSTypeAssertion(node) {
            context.report({ node, messageId: "forbidden" });
          },
        };
      },
    },
    "no-default-function-argument": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          forbidden: "関数引数のデフォルト値は禁止です。呼び出し側で値を指定してください",
        },
      },
      create(context) {
        return {
          AssignmentPattern(node) {
            let current = node;
            while (current.parent != null) {
              const parent = current.parent;
              if (Array.isArray(parent.params)) {
                if (parent.params.includes(current)) {
                  context.report({ node, messageId: "forbidden" });
                }
                return;
              }
              current = parent;
            }
          },
        };
      },
    },
    "explicit-named-function-return-type": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          missing: "名前付き関数には返り値の型を明示してください",
        },
      },
      create(context) {
        function check(node) {
          if (node.returnType == null) {
            context.report({ node, messageId: "missing" });
          }
        }
        return {
          FunctionDeclaration(node) {
            if (node.id != null) {
              check(node);
            }
          },
          FunctionExpression(node) {
            if (node.id != null) {
              check(node);
            }
          },
          MethodDefinition(node) {
            if (
              node.kind !== "constructor" &&
              node.kind !== "set" &&
              node.value.type === "FunctionExpression"
            ) {
              check(node.value);
            }
          },
          Property(node) {
            if (
              node.kind !== "set" &&
              node.method === true &&
              node.value.type === "FunctionExpression"
            ) {
              check(node.value);
            }
          },
        };
      },
    },
  },
};

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
    plugins: {
      "project-rules": projectRules,
    },
    rules: {
      "project-rules/no-type-assertion": "error",
      "project-rules/no-default-function-argument": "error",
      "project-rules/explicit-named-function-return-type": "error",
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
