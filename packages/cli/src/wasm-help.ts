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
  wasm init <directory> [--kind command|service] [--id <id>] [--from <file.wasm>] [--network none|vm|internet]
    Creates a module project: module.ts (manifest and adapter), unit tests, strict TypeScript and ESLint settings, CI and
    release workflows, and an example that wraps a tiny WebAssembly function. --from starts from your own .wasm file.
    A command module declares its id in commands, so programs in a VM can run it from a shell once an application turns
    it on; an id that starts with oxidevm is reserved and gets none. --network declares the module's reach (default none):
    vm adds net.vm, internet adds net.internet and a disclosure stub; both add src/net.ts and test/net.test.ts.
  wasm build [--project <directory>] [--out <directory>] [--module <file>] [--check]
    Reads the manifest from module.ts without running it, bundles the adapter into one file, pins every artifact and
    writes module.json, adapter.mjs, the artifacts and SHA256SUMS to dist/. --check verifies and writes nothing. Exits 3
    when it finds errors.
  wasm test [--project <directory>] [--module <dist>] [--image <bundle> --image-trust <A.public.json>] [--arg <value>]...
            [--option <name=value>]... [--browser chromium|firefox|webkit] [--engine-dir <release>] [--timeout-ms <ms>]
    Runs the runner-contract properties against the built module (dist/ by default) in a real browser: integrity, exit
    status, readiness, endpoints, duplicate start, snapshots, stop on end of input, restart, recovery after a kill,
    declared capabilities, and the network standard (no direct browser network, nothing beyond the reach, offline). Uses
    the public starter image unless --image names another. Exits 3 when a property fails.
  wasm release [--project <directory>] [--out <directory>] [--module <file>] [--repo <owner/name>]
    Builds, then prints the steps that publish the build as a GitHub release: tag, draft, verify, publish. It runs none of them.

Modules run in Userspace JS processes, in the VM's module frame, with a self-hosted runtime or the hosted runtime frame.
Every wasm command accepts --json.
`;

export function wasmCommandHelp(command: CliCommand): string {
  return `oxidevm ${command}\n${wasmHelp}`;
}
