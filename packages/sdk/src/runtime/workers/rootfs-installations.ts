import { exactKeys, record, string, protocolError } from "../decode.js";
import { decodeRootfsPackIndex, type RootfsPackIndex } from "../userspace-rootfs-packs.js";
import { decodeUserspaceRootfsManifest, rootfsClosure } from "../userspace-rootfs.js";
import { read, names, sha256, type Backend, type Scope } from "./rootfs-store-backend.js";

type Writer = (scope: Scope, name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
interface Journal {
  readonly version: 1;
  readonly manifestSHA256: string;
  readonly indexSHA256: string;
  readonly state: "installing" | "installed";
  readonly completedChunks: readonly string[];
}

/** Durable reachability for unpublished packs; journal claims never replace fresh body verification. */
export class RootfsInstallations {
  constructor(readonly backend: Backend, readonly write: Writer) {}

  async begin(digest: string, index: RootfsPackIndex): Promise<(chunk?: string) => Promise<void>> {
    const indexSHA256 = await sha256(encode(index));
    const completed = new Set<string>();
    const previous = await read(this.backend, "installations", `${digest}.json`);
    if (previous !== undefined) {
      const journal = decode(previous);
      if (journal.manifestSHA256 !== digest || journal.indexSHA256 !== indexSHA256) throw protocolError("installation journal names another image layout");
      const valid = new Set(index.chunks.map(chunk => chunk.sha256));
      for (const chunk of journal.completedChunks) {
        if (!valid.has(chunk)) throw protocolError("installation journal names an unknown chunk");
        completed.add(chunk);
      }
    }
    const publish = async (chunk?: string) => {
      if (chunk !== undefined) completed.add(chunk);
      const journal: Journal = { version: 1, manifestSHA256: digest, indexSHA256,
        state: chunk === undefined && completed.size === index.chunks.length ? "installed" : "installing", completedChunks: [...completed].sort() };
      await this.write("installations", `${digest}.json`, encode(journal));
    };
    // Re-verify every listed chunk on recovery; the journal retains references only.
    await this.write("installations", `${digest}.json`, encode({ version: 1, manifestSHA256: digest, indexSHA256, state: "installing", completedChunks: [...completed].sort() }));
    return publish;
  }

  async retained(): Promise<ReadonlyMap<string, RootfsPackIndex>> {
    const result = new Map<string, RootfsPackIndex>();
    for (const name of await names(this.backend, "installations")) {
      const bytes = await read(this.backend, "installations", name);
      if (bytes === undefined) throw protocolError("installation intent disappeared");
      const journal = decode(bytes);
      if (name !== `${journal.manifestSHA256}.json`) throw protocolError("installation filename differs from its identity");
      const manifestBytes = await read(this.backend, "manifests", name);
      if (manifestBytes === undefined || await sha256(manifestBytes) !== journal.manifestSHA256) throw protocolError("installation manifest is missing or damaged");
      const manifest = decodeUserspaceRootfsManifest(parse(manifestBytes), new URL("https://oxidevm-rootfs-cache.invalid/manifest.json"));
      let value: unknown = manifest.packs?.index;
      if (value === undefined) {
        const transport = await read(this.backend, "transports", name);
        if (transport === undefined) throw protocolError("installation transport is missing");
        const source = record(parse(transport), "installation transport");
        if (source["manifestSHA256"] !== journal.manifestSHA256) throw protocolError("installation transport names another image");
        value = record(source["packs"], "installation packs")["index"];
      }
      const index = decodeRootfsPackIndex(value, rootfsClosure(manifest));
      if (await sha256(encode(index)) !== journal.indexSHA256) throw protocolError("installation layout is damaged");
      result.set(journal.manifestSHA256, index);
    }
    return result;
  }
}

function encode(value: unknown): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(JSON.stringify(value)); }
function parse(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw protocolError("installation metadata is not valid JSON"); }
}
function decode(bytes: Uint8Array): Journal {
  if (bytes.length > 2 * 1024 ** 2) throw protocolError("installation journal exceeds its bound");
  const value = record(parse(bytes), "rootfs installation");
  exactKeys(value, ["version", "manifestSHA256", "indexSHA256", "state", "completedChunks"]);
  const manifestSHA256 = string(value["manifestSHA256"], "installation manifest"), indexSHA256 = string(value["indexSHA256"], "installation layout");
  const state = value["state"], input = value["completedChunks"];
  if (value["version"] !== 1 || !/^[0-9a-f]{64}$/u.test(manifestSHA256) || !/^[0-9a-f]{64}$/u.test(indexSHA256)
    || state !== "installing" && state !== "installed" || !Array.isArray(input) || input.length > 10_240) throw protocolError("invalid installation journal");
  const completedChunks = Array.from<unknown>(input).map(chunk => {
    const digest = string(chunk, "installation chunk");
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw protocolError("invalid installation chunk");
    return digest;
  });
  if (new Set(completedChunks).size !== completedChunks.length) throw protocolError("duplicate installation chunk");
  return { version: 1, manifestSHA256, indexSHA256, state, completedChunks };
}
