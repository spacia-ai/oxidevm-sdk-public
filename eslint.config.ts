import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.cache/**", "**/.oxidevm/**", ".candidate/**", ".private/**", "config/public-files/**", "packages/sdk/assets/**", "**/public/**", "coverage/**", "test-results/**", "playwright-report/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map(config => ({ ...config, files: ["**/*.ts", "**/*.tsx"] })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.config.json", "./tsconfig.examples-node.json", "./tsconfig.browser-tests.json", "./packages/sdk/tsconfig.browser.json", "./packages/sdk/tsconfig.worker.json", "./packages/sdk/tsconfig.test.json", "./packages/sdk/tsconfig.worker-test.json", "./packages/sdk/tsconfig.node.json", "./packages/sdk/tsconfig.browser-tools.json", "./packages/sdk/tsconfig.preview-browser.json", "./packages/sdk/tsconfig.preview-worker.json", "./packages/sdk/tsconfig.preview-node.json", "./packages/sdk/tsconfig.preview-test.json", "./packages/sdk/tsconfig.runtime-host.json", "./packages/sdk/tsconfig.runtime-host-worker.json", "./packages/cli/tsconfig.json", "./examples/starter/tsconfig.json", "./examples/starter/tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/no-confusing-void-expression": ["error", { "ignoreArrowShorthand": true, "ignoreVoidOperator": true, "ignoreVoidReturningFunctions": true }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { "allowBoolean": true, "allowNumber": true }],
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
    },
  },
  { files: ["eslint.config.ts", "packages/sdk/*.ts", "**/*.test.ts", "scripts/**/*.ts", "tests/browser/**/*.ts", "tests/integration/**/*.ts", "playwright.config.ts", "examples/*/*.ts"], languageOptions: { globals: globals.node } },
  { files: ["packages/sdk/src/*.ts", "packages/sdk/src/runtime/*.ts"], languageOptions: { globals: globals.browser } },
  { files: ["packages/sdk/src/runtime/workers/**/*.ts"], languageOptions: { globals: { ...globals.worker, ...globals.serviceworker } } },
  { files: ["examples/snapshot-authoring/*/prepare.ts", "examples/snapshot-authoring/*/verify.ts", "examples/snapshot-authoring/*/checks.ts", "packages/sdk/src/browser-test/**/*.ts", "examples/*/src/**/*.ts", "examples/*/src/**/*.tsx", "tests/diagnostics/**/*.ts", "packages/sdk/asset-source/preview/src/**/*.ts"], languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } } },
  { files: ["packages/sdk/src/browser-tools/**/*.ts", "packages/sdk/src/image-builder/**/*.ts", "packages/cli/src/**/*.ts"], languageOptions: { globals: globals.node } },
  { files: ["packages/sdk/asset-source/native-process/entry.ts"], languageOptions: { globals: globals.browser, parserOptions: { project: ["./packages/sdk/tsconfig.native-process.json"] } } },
  { files: ["tests/fixtures/native-addon/*.cjs", "tests/fixtures/nextjs-process-state.cjs"], languageOptions: { globals: globals.node } },
);
