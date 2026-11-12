/** The text of the files of a generated module project. */
import { NETWORK_RULES, networkSection, reachToken, type TemplateReach } from "./wasm-template-network.js";

/** Command names that start with this are reserved; the SDK's manifest decoder refuses them in `commands`. */
export const RESERVED_COMMAND_PREFIX = "oxidevm";

/** The command a generated command module declares: its id, which is always a valid command name unless the prefix is reserved. */
export function commandFor(id: string): string | undefined {
  return id.startsWith(RESERVED_COMMAND_PREFIX) ? undefined : id;
}

/** The name `oxidevm wasm stage` exports a module's handle under: `my-tool` becomes `myTool`. */
export function handleName(id: string): string {
  return id.replace(/-([a-z0-9])/gu, (_match, character: string) => character.toUpperCase());
}

/**
 * What a generated project is: a service, or a command module with the name its manifest declares in `commands`
 * (`undefined` when the id starts with the reserved prefix) that is either the add example or a `--from` skeleton.
 */
export type TemplateShape =
  | { readonly kind: "service" }
  | { readonly kind: "command"; readonly command: string | undefined; readonly skeleton: boolean };

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

/** What follows the command's name in its usage line. */
const USAGE_ARGUMENTS = "<a> <b>  (two 32-bit integers)";
const usage = (name: string): string => `usage: ${name} ${USAGE_ARGUMENTS}`;

/**
 * `src/command.ts` of the add example: the command's behavior, apart from the WebAssembly, against only the host members it
 * uses. `command` is the name module.ts declares, or undefined when the id is reserved and the module declares none.
 */
export function addCommandSource(id: string, command: string | undefined): string {
  const about = command === undefined
    ? ` * \`${id} <a> <b>\` prints the sum of two 32-bit integers.
 *
 * The application starts it with \`spawnModule\`. The module declares no commands, because command names that start with
 * "${RESERVED_COMMAND_PREFIX}" are reserved, so no program in the VM runs it by name.`
    : ` * \`${command} <a> <b>\` prints the sum of two 32-bit integers.
 *
 * The application starts it with \`spawnModule\`, and once it turns the module's commands on, any program in the VM runs
 * it as \`/usr/local/bin/${command}\`.`;
  const name = command === undefined
    ? `      // Only the application starts this module, so a usage line names the module.
      const name = ${JSON.stringify(id)};`
    : `      // Name the command as the caller typed it (perhaps a path, or a link to it); io.args never holds argv[0].
      const name = io.invocation.kind === "command" ? io.invocation.argv0 : ${JSON.stringify(id)};`;
  return `import type { BaseHost, CommandHooks, Host } from "@oxidevm/sdk/wasm";
import { parseOperands } from "./operands.ts";

/**
 * The host members the command uses. Asking for only these keeps it testable with a small stand-in instead of a whole
 * host, whose members grow with the SDK.
 */
export type AddHost = Pick<BaseHost, "fail"> & { readonly fs: Pick<Host<"files.sync">["fs"], "writeAll"> };

/**
${about}
 */
export function addCommand(host: AddHost, add: (left: number, right: number) => unknown): ${command === undefined ? "CommandHooks" : `CommandHooks<${JSON.stringify(command)}>`} {
  return {
    main(io) {
${name}
      const operands = parseOperands(io.args);
      if (operands === undefined) return host.fail(2, \`usage: \${name} ${USAGE_ARGUMENTS}\`);
      // writeAll writes every byte: a pipe may take only part of one write.
      host.fs.writeAll(io.stdout, new TextEncoder().encode(\`\${String(add(...operands))}\\n\`));
      return 0;
    },
  };
}
`;
}

/**
 * `test/command.test.ts` of the add example: runs the whole module, its WebAssembly included, through the SDK's real runner
 * with \`testHost\`, for each way the module can start.
 */
export function addCommandTest(id: string, command: string | undefined): string {
  const cases = command === undefined
    ? `describe(${JSON.stringify(`the ${id} command`)}, () => {
  it("prints the sum of its two arguments", async () => {
    expect(await run(["2", "3"])).toEqual({ status: 0, stdout: "5\\n", stderr: "" });
  });

  it("answers bad input with status 2 and a usage line", async () => {
    expect(await run(["2"])).toEqual({ status: 2, stdout: "", stderr: ${JSON.stringify(`${usage(id)}\n`)} });
  });
});
`
    : `/** How the runner describes a run that a program in the VM started by typing \`argv0\`. */
const fromVM = (argv0: string): Invocation => ({ kind: "command", name: ${JSON.stringify(command)}, argv0 });

describe(${JSON.stringify(`the ${command} command`)}, () => {
  it("prints the sum when the application starts the module", async () => {
    expect(await run(["2", "3"])).toEqual({ status: 0, stdout: "5\\n", stderr: "" });
  });

  it("prints the sum when a program in the VM runs it", async () => {
    expect(await run(["2", "3"], fromVM(${JSON.stringify(command)}))).toEqual({ status: 0, stdout: "5\\n", stderr: "" });
  });

  it("answers bad input with status 2 and a usage line that names the command as it was typed", async () => {
    expect(await run(["2"], fromVM(${JSON.stringify(command)}))).toEqual({ status: 2, stdout: "", stderr: ${JSON.stringify(`${usage(command)}\n`)} });
    expect(await run(["two", "3"], fromVM(${JSON.stringify(`/usr/local/bin/${command}`)}))).toEqual({ status: 2, stdout: "", stderr: ${JSON.stringify(`${usage(`/usr/local/bin/${command}`)}\n`)} });
    expect(await run([])).toEqual({ status: 2, stdout: "", stderr: ${JSON.stringify(`${usage(id)}\n`)} });
  });
});
`;
  return `import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { testHost, type TestHostInputs } from "@oxidevm/sdk/wasm/testing";
import definition from "../module.ts";

type Invocation = NonNullable<TestHostInputs["invocation"]>;

/** The artifact the release pins, read from this repository. */
const artifacts = { "add.wasm": new Uint8Array(await readFile(new URL("../upstream/add.wasm", import.meta.url))) };

/** Runs the module once through the SDK's runner, as the browser would, and returns what it wrote. */
async function run(args: readonly string[], invocation?: Invocation): Promise<{ status: number; stdout: string; stderr: string }> {
  const { status, stdout, stderr } = await testHost(definition, { args, artifacts, ...(invocation === undefined ? {} : { invocation }) }).run();
  return { status, stdout, stderr };
}

${cases}`;
}

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

export function moduleTest(id: string, shape: TemplateShape, reach: TemplateReach): string {
  const commands = shape.kind === "service" ? ""
    : shape.command === undefined
      ? `    // Command names that start with "${RESERVED_COMMAND_PREFIX}" are reserved, so this module declares none.\n    expect("commands" in definition.manifest).toBe(false);\n`
      : `    expect(definition.manifest.commands).toEqual([${JSON.stringify(shape.command)}]);\n`;
  return `import { describe, expect, it } from "vitest";
import definition from "../module.ts";

describe("module definition", () => {
  it("declares what the build and the consumer read", () => {
    expect(definition.manifest.id).toBe(${JSON.stringify(id)});
    expect(definition.manifest.process.kind).toBe(${JSON.stringify(shape.kind)});
${commands}    // The module's network reach (engine ADR 0029): Rust holds every process of the module to it.
    const host: readonly string[] = definition.manifest.requires.host;
    expect(host.filter(token => token.startsWith("net."))).toEqual(${JSON.stringify(reachToken(reach) === undefined ? [] : [reachToken(reach)])});
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
export const TEMPLATE_PLAYWRIGHT = "1.64.0";

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

/** The rules for a command module's runs that programs in the VM start (engine ADR 0027). */
const COMMAND_RULES = `
## Commands that programs in the VM run

Each name in \`commands\` becomes a program: once an application turns it on for a VM (\`enableModuleCommands\`), any program there runs the module as \`/usr/local/bin/<name>\`, in a fresh process with the caller's arguments, environment, directory and standard streams.

- Name the command with \`io.invocation.argv0\` in usage lines and errors; the caller may have typed a path or a link. \`io.args\` never contains argv[0].
- Standard input may be a terminal, a pipe, a file or empty. Read it only when the command's interface says so, and until a read returns no bytes.
- Use colour or prompts only when \`io.terminals\` says that descriptor is a terminal.
- Return 0-119 from \`main\`, and 2 for a usage error. Never throw for a user's mistake: a throw ends the run with status 123.
- A signal kills the process at once and \`close()\` does not run, unless the module declares \`process.signals\`. If you trap a signal, finish quickly, then \`untrap()\` and \`raise()\` it, so the caller sees the process killed by that signal and a shell loop stops.
- Write results atomically (a temporary file, then a rename), so an interrupted run never leaves half a file.
- Choose names that do not shadow image programs unless you mean to: \`/usr/local/bin\` comes before \`/usr/bin\` on PATH. Adding a name in a later release makes every application consent again.
- Never list your own command (\`/usr/local/bin/<name>\`) in \`requires.guest.executables\`, and never start your own command through PATH.
- Keep start-up cheap: every run starts a fresh process, which runs the adapter factory again.
`;

export function agentsFile(id: string, shape: TemplateShape): string {
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
${shape.kind === "command" ? COMMAND_RULES : ""}${NETWORK_RULES}`;
}

/** The README section of a command module: how an application turns its command on, and what a shell then sees. */
function shellSection(id: string, command: string | undefined, skeleton: boolean): string {
  if (command === undefined) {
    return `
## Run it from a shell

The module declares no commands: command names that start with \`${RESERVED_COMMAND_PREFIX}\` are reserved. To let programs in a VM run it, add \`commands: ["<name>"]\` after \`process\` in \`module.ts\` with a name of your own; an application then turns it on with \`enableModuleCommands(vm, ${handleName(id)})\`, and programs run it as \`/usr/local/bin/<name>\`.
`;
  }
  return `
## Run it from a shell

The module declares the command \`${command}\`. An application that installed it turns the command on for one Userspace VM, and from then on any program in that VM can run it:

\`\`\`ts
import { enableModuleCommands } from "@oxidevm/sdk/wasm";
import { ${handleName(id)} } from "./oxidevm.modules.generated";

const commands = await enableModuleCommands(vm, ${handleName(id)});
// A terminal in the VM now runs \`${skeleton ? command : `${command} 2 3`}\`${skeleton ? " like any other program" : ", which prints 5"}.
await commands.disable();
\`\`\`

A third argument turns on only some of a module's commands (\`commands\`), sets its \`options\`, and bounds how many runs may be active at once (\`concurrency\`, 4 by default).

Turning the command on places a stub at \`/usr/local/bin/${command}\`. A shell finds it when its \`PATH\` lists \`/usr/local/bin\` before \`/usr/bin\`, and then the command takes the place of an image program with the same name. It runs as the guest user, with the caller's arguments, environment, working directory and standard streams. A shell sees these exit statuses:

| Status | Meaning |
| --- | --- |
| 0-119 | the module's own status |
| 120 | the module could not be launched |
| 122 | a prerequisite is missing |
| 123 | the adapter failed: it threw, or returned an invalid status |
| 125 | the engine failed |
| 126 | the stub ran as an ordinary program: the command is not turned on in this VM, or more runs are active than \`concurrency\` allows |
| 127 | the command is not on \`PATH\` |
| 128+n | the process was killed by signal n (130 for Ctrl+C) |
`;
}

export function readmeFile(id: string, shape: TemplateShape, reach: TemplateReach): string {
  const run = shape.kind === "command"
    ? "A command module runs once per start, like a program: `spawnModule(vm, handle, { args: [\"2\", \"3\"] })`."
    : "A service module listens on the sockets its manifest declares and serves clients until it is stopped.";
  return `# ${id}

An [OxideVM](https://oxidevm.dev) WebAssembly module (${shape.kind}). ${run}

## Use it

In an OxideVM application:

\`\`\`sh
oxidevm wasm add github:OWNER/REPO@v0.1.0
\`\`\`

The command shows what the module declares and asks before installing it.
${shape.kind === "command" ? shellSection(id, shape.command, shape.skeleton) : ""}${networkSection(reach)}
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
