import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const authoredJavaScript = ["**/*.{js,cjs,mjs}"];
const authoredNodeTypeScript = ["packages/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"];
const authoredTypeScript = authoredNodeTypeScript;
const [typescriptBase, typescriptEslintRecommended, typescriptRecommended] =
  tseslint.configs.recommended;

export default [
  {
    ignores: [
      ".agents/**",
      ".basalt/**",
      "dist/**",
      "node_modules/**",
      "plugin/BasaltStudioPlugin.rbxmx",
    ],
  },
  {
    files: authoredJavaScript,
    ...eslint.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: authoredTypeScript,
    languageOptions: {
      ...typescriptBase.languageOptions,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: typescriptBase.plugins,
    rules: {
      ...typescriptEslintRecommended.rules,
      ...typescriptRecommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: authoredNodeTypeScript,
    languageOptions: { globals: globals.node },
  },
];
