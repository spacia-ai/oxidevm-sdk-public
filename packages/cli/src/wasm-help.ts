import type { CliCommand } from "./contracts.js";

export const wasmHelp = `
  wasm add <github:owner/repo@tag | file:directory> [--project <directory>] [--yes] [--offline]
    Resolves a module release, shows what it declares and asks before installing it. Writes oxidevm.modules.json,
    oxidevm.modules.lock.json, modules/<id>/module.json and the staged files, and generates src/oxidevm.modules.generated.ts.
    A source whose owner is listed under "trusted" is installed without a question the first time; a release that asks for
    more authority than the installed one always asks again. --yes accepts after you have reviewed the module.
  wasm stage [--project <directory>] [--offline]
    Rebuilds the staged files and generated handles from the lock (use it after cloning a project).
  wasm doctor [--project <directory>]
    Checks that declaration, lock, committed module.json files, staged files and generated handles agree, and what the SDK
    and browser must provide.
  wasm inspect <file.wasm>
    Reports a WebAssembly binary's imports, exports and the ABI it appears to use.
  wasm init <directory> [--kind command|service] [--id <id>] [--from <file.wasm>]
    Creates a module project: module.ts (manifest and adapter), unit tests, strict TypeScript and ESLint settings, CI and
    release workflows, and an example that wraps a tiny WebAssembly function. --from starts from your own .wasm file.
  wasm build [--project <directory>] [--out <directory>] [--module <file>] [--check]
    Reads the manifest from module.ts without running it, bundles the adapter into one file, pins every artifact and
    writes module.json, adapter.mjs, the artifacts and SHA256SUMS to dist/. --check verifies and writes nothing. Exits 3
    when it finds errors.
  wasm release [--project <directory>] [--out <directory>] [--module <file>] [--repo <owner/name>]
    Builds, then prints the steps that publish the build as a GitHub release: tag, draft, verify, publish. It runs none of them.

Modules run in Userspace JS processes and need a self-hosted runtime. Every wasm command accepts --json.
`;

export function wasmCommandHelp(command: CliCommand): string {
  return `oxidevm ${command}\n${wasmHelp}`;
}
