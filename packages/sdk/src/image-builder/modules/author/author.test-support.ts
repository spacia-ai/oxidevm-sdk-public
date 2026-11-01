import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

/** A module source with a literal manifest and an adapter, parameterized by what a test varies. */
export function moduleSource(options: { readonly manifest?: string; readonly adapter?: string; readonly imports?: string } = {}): string {
  const manifest = options.manifest ?? `{ id: "demo", version: "1.0.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" } }`;
  const adapter = options.adapter ?? `host => ({ main(io) { host.fs.writeFile("/workspace/out.txt", new TextEncoder().encode(io.args.join(","))); return 0; } })`;
  return `import { defineModule } from "@oxidevm/sdk/wasm";\n${options.imports ?? ""}export default defineModule({\n  manifest: ${manifest},\n  adapter: ${adapter},\n});\n`;
}

/**
 * Creates temporary project directories from `{ path: text }` maps and removes them after each test. Call it once
 * in a test file; the returned function makes a project.
 */
export function projects(): (files: Readonly<Record<string, string | Uint8Array>>) => Promise<string> {
  const created: string[] = [];
  afterEach(async () => { await Promise.all(created.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
  return async files => {
    const directory = await mkdtemp(join(tmpdir(), "oxidevm-author-"));
    created.push(directory);
    for (const [path, content] of Object.entries(files)) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return directory;
  };
}

/** Imports a built adapter from its bytes and returns its default export, which must be the factory function. */
export async function importAdapter(bytes: Uint8Array): Promise<(host: unknown) => unknown> {
  const namespace: unknown = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`);
  const factory: unknown = typeof namespace === "object" && namespace !== null ? Reflect.get(namespace, "default") : undefined;
  if (typeof factory !== "function") throw new Error("the adapter has no default export function");
  return host => { const hooks: unknown = Reflect.apply(factory, undefined, [host]); return hooks; };
}

/** A hook of the object an adapter factory returned, callable with the hooks object as `this`. */
export function hookOf(hooks: unknown, name: string): (...args: unknown[]) => unknown {
  const found: unknown = typeof hooks === "object" && hooks !== null ? Reflect.get(hooks, name) : undefined;
  if (typeof found !== "function") throw new Error(`no ${name} hook`);
  return (...args) => { const result: unknown = Reflect.apply(found, hooks, args); return result; };
}
