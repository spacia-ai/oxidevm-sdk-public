/** The fixed files of a generated module project. Nothing here depends on the module's id or kind. */

/** A hand-assembled WebAssembly module exporting `add(i32, i32) -> i32`, so the example needs no binary in source control. */
export const ADD_WASM: Uint8Array<ArrayBuffer> = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

export const OPERANDS_SOURCE = `/** Reads exactly two 32-bit signed integers from text; \`undefined\` when there are not exactly two valid ones. */
export function parseOperands(args: readonly string[]): readonly [number, number] | undefined {
  const [left, right, ...rest] = args;
  if (left === undefined || right === undefined || rest.length > 0) return undefined;
  const first = parseInteger(left), second = parseInteger(right);
  return first === undefined || second === undefined ? undefined : [first, second];
}

function parseInteger(text: string): number | undefined {
  if (!/^-?\\d{1,10}$/u.test(text)) return undefined;
  const value = Number(text);
  return value >= -2147483648 && value <= 2147483647 ? value : undefined;
}
`;

export const OPERANDS_TEST = `import { describe, expect, it } from "vitest";
import { parseOperands } from "../src/operands.ts";

describe("parseOperands", () => {
  it("reads two 32-bit integers", () => {
    expect(parseOperands(["2", "-3"])).toEqual([2, -3]);
    expect(parseOperands(["2147483647", "-2147483648"])).toEqual([2147483647, -2147483648]);
  });

  it("refuses anything else", () => {
    for (const args of [[], ["1"], ["1", "2", "3"], ["1", "x"], ["1.5", "2"], ["2147483648", "1"], ["", "1"], ["1e3", "1"]]) {
      expect(parseOperands(args)).toBeUndefined();
    }
  });
});
`;

export const TSCONFIG = `{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "lib": ["ES2024", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedIndexedAccess": true,
    "noUncheckedSideEffectImports": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": false,
    "strict": true,
    "target": "ES2024",
    "types": [],
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true
  },
  "include": ["module.ts", "src"]
}
`;

/** Tests run in Node, so they alone see Node's types; the module and its helpers are checked without them, as they run in a worker. */
export const TEST_TSCONFIG = `{
  "extends": "../tsconfig.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["./**/*.ts", "../module.ts", "../src/**/*.ts"]
}
`;

export function moduleTest(id: string, kind: "command" | "service"): string {
  return `import { describe, expect, it } from "vitest";
import definition from "../module.ts";

describe("module definition", () => {
  it("declares what the build and the consumer read", () => {
    expect(definition.manifest.id).toBe(${JSON.stringify(id)});
    expect(definition.manifest.process.kind).toBe(${JSON.stringify(kind)});
    expect(typeof definition.adapter).toBe("function");
  });
});
`;
}

export const ESLINT_CONFIG = `import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/**", "node_modules/**", "eslint.config.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
);
`;

export const GITIGNORE = `node_modules/
dist/
*.log
`;

/**
 * A CLI that needs a private registry (it writes an `.npmrc`) generates projects whose @oxidevm packages a GitHub runner
 * cannot install, so an automatic run would fail on every push. Its workflows start on request, and say so.
 */
const MANUAL_NOTE = `# This workflow starts on request only. The @oxidevm packages of the CLI that generated this project are on a private registry
# that GitHub's runners cannot reach, so an automatic run would fail on every push. Give it the push (and pull_request, or tag)
# trigger of the public template once the packages install from a registry the runner can reach.
`;
const MANUAL_TRIGGER = "on:\n  workflow_dispatch:\n";

/**
 * The Playwright version \`oxidevm wasm test\` drives, which is the SDK's own dependency. The template declares the same
 * version so \`pnpm exec playwright install\` fetches the browser build that version expects; a test keeps them equal.
 */
export const TEMPLATE_PLAYWRIGHT = "1.61.1";

export function ciWorkflow(manual: boolean): string {
  const trigger = manual ? MANUAL_TRIGGER : "on:\n  push:\n    branches: [main]\n  pull_request:\n";
  return `${manual ? MANUAL_NOTE : ""}name: ci
${trigger}permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm run check
      - run: pnpm test
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm run test:conformance
`;
}

export function releaseWorkflow(manual: boolean): string {
  const trigger = manual ? MANUAL_TRIGGER : 'on:\n  push:\n    tags: ["v*"]\n';
  return `# Publishing is the only step that changes what other people install, so it goes draft, verify, publish:
# the draft is downloaded again and checked against its own SHA256SUMS before it becomes visible.
# Dependencies install and build in a job that can only read; the job that may write to the repository runs
# nothing but the gh commands, so no install script or dependency code ever sees its token.
${manual ? `${MANUAL_NOTE}# Start it from a tag: pick the tag, not a branch, in the Run workflow dialog, because the first check compares the tag with the version.\n` : ""}name: release
${trigger}permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - name: The tag must name the version in module.json
        run: test "v$(node -p "JSON.parse(require('node:fs').readFileSync('dist/module.json', 'utf8')).version")" = "$GITHUB_REF_NAME"
      - uses: actions/upload-artifact@v4
        with:
          name: release-files
          path: dist/*
          if-no-files-found: error
  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
      GH_TOKEN: \${{ github.token }}
      GH_REPO: \${{ github.repository }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: release-files
          path: dist
      - name: Draft the release
        run: gh release create "$GITHUB_REF_NAME" dist/* --draft --verify-tag --title "$GITHUB_REF_NAME" --generate-notes
      - name: Verify the draft
        run: |
          mkdir verify
          gh release download "$GITHUB_REF_NAME" --dir verify
          cd verify
          sha256sum --check SHA256SUMS
      - name: Publish
        run: gh release edit "$GITHUB_REF_NAME" --draft=false
`;
}

/** A stub for the module's own notice. The CLI's NOTICE describes the CLI (esbuild, a Go runtime, fonts), not a module project. */
export function noticeFile(id: string): string {
  return `${id}
Copyright (c) <year> <copyright holder>

An OxideVM WebAssembly module. Replace this file with the copyright and attribution notices of this module and of every program
or library whose code or binaries it ships; the Apache License asks a redistributor to keep the NOTICE files of the works it
redistributes. Keep the license texts of shipped binaries in this repository too, and name the files in license.notices.
`;
}

export function agentsFile(id: string): string {
  return `# ${id}: instructions for coding agents

This repository is an OxideVM WebAssembly module. \`module.ts\` holds the whole definition: a literal \`manifest\` and the \`adapter\` that runs the WebAssembly inside a Userspace JS process.

- Edit \`module.ts\`, \`src/\` and \`test/\`. Never edit \`dist/\`; \`pnpm run build\` writes it.
- Keep the manifest a literal. The build reads it without running code, so it cannot call functions or use variables.
- Declare in \`requires.host\` only what the adapter uses. The adapter's \`host\` has exactly those members, and the type checker enforces it.
- Import types from \`@oxidevm/sdk/wasm\` with \`import type\`; the only value import is \`defineModule\`. The adapter ships as one self-contained file.
- No \`any\`, no \`@ts-ignore\`, no non-null assertions. Treat everything from outside (arguments, bytes, WebAssembly exports) as \`unknown\` and check it.
- Artifacts are files in this repository named by \`from\`. Pin upstream binaries by hash where they come from, and keep their licenses and notices in this repository.
- Verify with \`pnpm run check\` (types, lint, and \`oxidevm wasm build --check\`), then \`pnpm test\`, then \`pnpm run test:conformance\` (\`oxidevm wasm test\` in a real browser).
- Release by tag: \`pnpm run release\` prints the steps.
`;
}

export function readmeFile(id: string, kind: "command" | "service"): string {
  const run = kind === "command"
    ? "A command module runs once per start, like a program: `spawnModule(vm, handle, { args: [\"2\", \"3\"] })`."
    : "A service module listens on the sockets its manifest declares and serves clients until it is stopped.";
  return `# ${id}

An [OxideVM](https://oxidevm.dev) WebAssembly module (${kind}). ${run}

## Use it

In an OxideVM application:

\`\`\`sh
oxidevm wasm add github:OWNER/REPO@v0.1.0
\`\`\`

The command shows what the module declares and asks before installing it.

## Develop it

\`\`\`sh
pnpm install
pnpm run check   # types, lint, and the same checks the build makes
pnpm test        # unit tests of your own code
pnpm run test:conformance   # oxidevm wasm test: the runner's contract, in Chromium
pnpm run build   # writes dist/: module.json, adapter.mjs, your artifacts and SHA256SUMS
\`\`\`

\`module.ts\` is the whole definition. \`upstream/\` holds the WebAssembly files the module wraps.

## Release it

\`\`\`sh
git tag v0.1.0 && git push origin v0.1.0
\`\`\`

The tag must name the version in \`module.ts\`. The \`release\` workflow builds, drafts a GitHub release with every file in \`dist/\`, downloads it again to verify its \`SHA256SUMS\`, and publishes it. \`pnpm run release\` prints the same steps for doing it by hand.

## License

Apache-2.0 (see \`LICENSE\`). Change the license in \`module.ts\` and this repository to match the code you wrap, and keep the notices of anything you bundle.
`;
}
