import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { build } from "vite";
const root = resolve(import.meta.dirname, "..");
const sdkDist = await realpath(resolve(root, process.argv[2] ?? "packages/sdk/dist"));
const localSDKDist = await realpath(resolve(root, "packages/sdk/dist"));
const output = resolve(root, process.argv[3] ?? ".cache/command-interceptors/bundle");
await build({ configFile: false, root, worker: { format: "es" }, plugins: [{
  name: "qualification-sdk-distribution", enforce: "pre",
  resolveId(source, importer) {
    if (importer === undefined || !source.startsWith(".")) return null;
    const path = resolve(dirname(importer), source);
    return path.startsWith(localSDKDist + sep) ? resolve(sdkDist, relative(localSDKDist, path)) : null;
  },
  generateBundle() {
    if (sdkDist !== localSDKDist) for (const id of this.getModuleIds()) {
      if (id.startsWith(localSDKDist + sep)) this.error(`Fixture retained a second SDK distribution: ${id}`);
    }
  },
}], build: {
  target: "esnext", outDir: output, emptyOutDir: true,
  rollupOptions: { preserveEntrySignatures: "strict", input: { diagnostics: resolve(sdkDist, "diagnostics.js"), "tsc-adapter": resolve(sdkDist, "runtime/workers/command-interceptors/worker-system.js"), runtime: resolve(sdkDist, "runtime/index.js"), sdk: resolve(sdkDist, "index.js"), machine: resolve(sdkDist, "machine.js"), ...(process.argv[4] === "native-addon" ? { "native-diagnostics": resolve(root, "tests/diagnostics/native-addon-runtime.ts") } : {}) }, output: { entryFileNames: "[name].js", format: "es" } },
} });
