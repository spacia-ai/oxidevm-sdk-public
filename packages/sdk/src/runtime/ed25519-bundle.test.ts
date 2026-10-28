import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";

it("bundles image signature verification into a classic browser worker without code splitting", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-classic-signature-"));
  try {
    const verifier = fileURLToPath(new URL("./ed25519.ts", import.meta.url));
    await writeFile(join(root, "entry.js"), "export function create() { return new Worker(new URL('./worker.js', import.meta.url)); }\n");
    await writeFile(join(root, "worker.js"), `import { verifyEd25519 } from ${JSON.stringify(verifier)};
self.onmessage = async () => {
  await verifyEd25519(new Uint8Array(32), 'A'.repeat(86), new Uint8Array(100000), 'worker fixture');
  self.postMessage('verified');
};\n`);
    await expect(build({ configFile: false, root, logLevel: "silent", worker: { format: "iife" },
      build: { write: false, minify: false, rollupOptions: { input: join(root, "entry.js") } } })).resolves.toBeDefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
