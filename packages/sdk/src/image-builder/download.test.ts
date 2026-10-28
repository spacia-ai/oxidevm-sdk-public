import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { downloadBundle } from "./download.js";
import { hash } from "./files.js";

afterEach(() => vi.unstubAllGlobals());
function file(path: string, text: string): Buffer {
  const header = Buffer.alloc(512); const body = Buffer.from(text);
  new Header({ path, type: "File", mode: 0o644, size: body.length }).encode(header);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
async function fixture(entries: readonly Buffer[], run: (out: string, artifact: { url: string; bytes: number; sha256: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-release-unpack-"));
  try {
    const bytes = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(bytes)));
    await run(join(directory, "bundle"), { url: "https://release.example.test/pinned.tgz", bytes: bytes.length, sha256: hash(bytes) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
it("rejects duplicate normalized release paths and preserves the previous installed bundle", async () => {
  await fixture([file("value", "first"), file("./value", "replacement")], async (out, artifact) => {
    await mkdir(out); await writeFile(join(out, "previous"), "keep");
    let validated = false;
    await expect(downloadBundle(artifact, out, () => { validated = true; return Promise.resolve(); })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(validated).toBe(false); expect(await readFile(join(out, "previous"), "utf8")).toBe("keep");
    expect(await readdir(join(out, ".."))).toEqual(["bundle"]);
  });
});
it("admits one complete regular-file release only after its final validation", async () => {
  await fixture([file("value", "exact pinned bytes")], async (out, artifact) => {
    await downloadBundle(artifact, out, async stage => { expect(await readFile(join(stage, "value"), "utf8")).toBe("exact pinned bytes"); });
    expect(await readFile(join(out, "value"), "utf8")).toBe("exact pinned bytes");
  });
});
