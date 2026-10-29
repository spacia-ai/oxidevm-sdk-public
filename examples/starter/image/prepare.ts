import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function prepareInputs(value: unknown, directory: string): Promise<void> {
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
}
await prepareInputs(JSON.parse(await readFile(new URL("./inputs.lock.json", import.meta.url), "utf8")), join(import.meta.dirname, ".cache/inputs"));
const python: unknown = JSON.parse(await readFile(new URL("./python-inputs.lock.json", import.meta.url), "utf8"));
if (typeof python !== "object" || python === null || !("inputs" in python) || !("base" in python)) throw new Error("Invalid Python inputs");
if (!Array.isArray(python.inputs)) throw new Error("Invalid Python input list");
const pythonInputs = Array.from<unknown>(python.inputs).map(value => { if (typeof value !== "object" || value === null || !("filename" in value) || !("url" in value) || !("sha256" in value)) throw new Error("Invalid Python input"); return { name: value.filename, url: value.url, sha256: value.sha256 }; });
await prepareInputs(pythonInputs, join(import.meta.dirname, ".cache/python-inputs"));
const base = python.base;
if (typeof base !== "object" || base === null || !("sha256" in base) || !("filename" in base) || base.filename !== "docs-python-rootfs.tar.gz" || typeof base.sha256 !== "string") throw new Error("Invalid Python base identity");
const supplied = process.env["OXIDEVM_PANDAS_BASE_ROOTFS"];
const destination = join(import.meta.dirname, ".cache/python-inputs/docs-python-rootfs.tar.gz");
if (supplied !== undefined) {
  if (createHash("sha256").update(await readFile(supplied)).digest("hex") !== base.sha256) throw new Error("Python base archive differs from its qualified digest");
  await copyFile(supplied, destination);
}
if (createHash("sha256").update(await readFile(destination)).digest("hex") !== base.sha256) throw new Error("Supply the qualified base archive through OXIDEVM_PANDAS_BASE_ROOTFS");
await writeFile(join(import.meta.dirname, ".cache/python-inputs/BASE.SHA256SUMS"), `${base.sha256}  ${base.filename}\n`);
process.stdout.write("Verified all pinned utility, Python, NumPy and pandas inputs.\n");
