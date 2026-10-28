import { Header } from "tar";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { materializeSource } from "./sources.js";
import { hash } from "./files.js";
import { unpackSourceArchive } from "./archive.js";

function entry(path: string, text = "", type: "File" | "Link" | "SymbolicLink" = "File", linkpath?: string): Buffer {
  const block = Buffer.alloc(512); const body = Buffer.from(text);
  new Header({ path, type, size: body.length, mode: 0o755, uid: 0, gid: 0, ...(linkpath === undefined ? {} : { linkpath }) }).encode(block);
  return Buffer.concat([block, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
async function archive(bytes: Buffer, run: (root: string, input: Parameters<typeof materializeSource>[0], staging: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-archive-safety-"));
  try {
    await writeFile(join(root, "source.tar"), bytes); const staging = join(root, "staging"); await mkdir(staging);
    await run(root, { kind: "archive", artifact: { path: "source.tar", sha256: hash(bytes) } }, staging);
  } finally { await rm(root, { recursive: true, force: true }); }
}
it("rejects duplicate normalized archive paths before extracting either payload", async () => {
  await archive(Buffer.concat([entry("same", "first"), entry("./same", "second"), Buffer.alloc(1024)]), async (root, input, staging) => {
    await expect(materializeSource(input, staging, { recipeDir: root, signingKeyFile: "unused" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(join(staging, "rootfs/same"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
it("resolves a bounded forward hardlink chain through regular files", async () => {
  await archive(Buffer.concat([entry("first", "", "Link", "second"), entry("second", "", "Link", "last"), entry("last", "actual"), Buffer.alloc(1024)]), async (root, input, staging) => {
    const source = await materializeSource(input, staging, { recipeDir: root, signingKeyFile: "unused" });
    expect(await readFile(join(source.root, "first"), "utf8")).toBe("actual");
  });
});
it("rejects a cyclic hardlink graph with a structured error", async () => {
  await archive(Buffer.concat([entry("first", "", "Link", "second"), entry("second", "", "Link", "first"), Buffer.alloc(1024)]), async (root, input, staging) => {
    await expect(materializeSource(input, staging, { recipeDir: root, signingKeyFile: "unused" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

it("closes real extraction files before a mid-write cancellation settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-archive-cancel-"));
  const output = join(root, "output"); await mkdir(output);
  const block = Buffer.alloc(512); const size = 32 * 1024 ** 2;
  new Header({ path: "large", type: "File", mode: 0o644, uid: 0, gid: 0, size }).encode(block);
  const input = join(root, "input.tgz"); await writeFile(input, gzipSync(Buffer.concat([block, Buffer.alloc(size), Buffer.alloc(1024)]), { level: 0 }));
  const cancellation = new AbortController();
  const observer = watch(output, (_event, filename) => { if (filename === "large") cancellation.abort(); });
  try {
    await expect(unpackSourceArchive(input, output, cancellation.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(cancellation.signal.aborted).toBe(true);
    const descriptors = await readdir("/proc/self/fd");
    const paths = await Promise.all(descriptors.map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => "closed")));
    expect(paths.filter(path => path.startsWith(`${output}/`))).toEqual([]);
  } finally { observer.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);
