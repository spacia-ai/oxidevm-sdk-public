import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c, Parser } from "tar";
import { describe, expect, it } from "vitest";
import { readTarFile } from "./tar-reader.js";

describe("bounded source archive reader", () => {
  it("propagates a parser rejection without Node pipe cleanup errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "source-parser-"));
    try {
      await writeFile(join(directory, "file"), "contents"); const archive = join(directory, "source.tgz");
      await c({ cwd: directory, file: archive, gzip: true }, ["file"]);
      const parser = new Parser({ onReadEntry: entry => { entry.resume(); parser.abort(new Error("Rejected source entry")); } });
      await expect(readTarFile(archive, parser)).rejects.toThrow("Rejected source entry");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
