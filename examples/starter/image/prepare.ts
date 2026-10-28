import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const value: unknown = JSON.parse(await readFile(new URL("./inputs.lock.json", import.meta.url), "utf8"));
if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new Error("Invalid image input lock");
const inputs = Array.from<unknown>(value).map(value => {
  if (typeof value !== "object" || value === null || !("name" in value) || !("url" in value) || !("sha256" in value)) throw new Error("Invalid image input");
  const { name, url, sha256 } = value;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.+-]+$/u.test(name) || typeof url !== "string" || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid image input identity");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new Error("Image input requires HTTPS");
  return { name, url, sha256 };
});
if (new Set(inputs.map(input => input.name)).size !== inputs.length) throw new Error("Duplicate image input");
const directory = join(import.meta.dirname, ".cache/inputs");
await mkdir(directory, { recursive: true });
for (const input of inputs) {
  const file = join(directory, input.name);
  let bytes = await readFile(file).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (bytes === undefined) {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || response.body === null) throw new Error(`Cannot download pinned input ${input.name}`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array) || (size += chunk.length) > 128 * 1024 ** 2) throw new Error("Image input exceeds its 128 MiB limit");
        chunks.push(chunk);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error(`Checksum mismatch for ${input.name}`);
    const temporary = `${file}.${randomUUID()}.download`;
    try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error(`Cached image input changed: ${input.name}`);
}
await writeFile(join(directory, "SHA256SUMS"), inputs.map(input => `${input.sha256}  ${input.name}\n`).join(""));
process.stdout.write("Verified all pinned runtime, utility source and build inputs.\n");
