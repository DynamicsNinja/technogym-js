// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "mcp/dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Hard constraint: no `any` anywhere. Response payloads are `unknown` and narrowed by the
      // parsers in src/parse.ts; if a boundary genuinely needs `any`, disable it inline with a reason.
      "@typescript-eslint/no-explicit-any": "error",
      // Template literals over numbers and booleans read fine and are used for URLs and messages.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // SessionStore implementations and mocked fetch stand-ins implement a Promise-returning
      // interface with bodies that need no `await`.
      "@typescript-eslint/require-await": "off",
      // Leading-underscore names mean "required by a signature but intentionally unused".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts", "examples/**/*.ts", "mcp/tests/**/*.ts"],
    rules: {
      // Tests and scripts reach into fixtures and mocked fetch with loose typing.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The MCP server may use the library ONLY through its public entry point.
    files: ["mcp/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(\\.\\./)+\\.\\./src/",
              message: 'Import from "technogym-js" instead.',
            },
          ],
        },
      ],
    },
  },
);
