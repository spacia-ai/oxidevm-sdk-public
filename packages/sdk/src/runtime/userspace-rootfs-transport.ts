import { exactKeys, protocolError, record, string } from "./decode.js";
import { rootfsClosure, type UserspaceRootfsManifest } from "./userspace-rootfs.js";
import { decodeUserspaceRootfsPacks, type UserspaceRootfsPacks } from "./userspace-rootfs-packs.js";

/** A transport sidecar changes acquisition only; the signed logical image remains authoritative. */
export function rootfsTransportURL(manifestURL: URL, digest: string): URL {
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw protocolError("invalid transport manifest digest");
  return new URL(`transport/${digest}/packs-v1.json`, manifestURL);
}

export function decodeRootfsTransport(value: unknown, manifest: UserspaceRootfsManifest, digest: string, base: URL): UserspaceRootfsPacks {
  const input = record(value, "rootfs transport");
  exactKeys(input, ["version", "manifestSHA256", "packs"]);
  if (input["version"] !== 1 || string(input["manifestSHA256"], "transport manifest") !== digest) {
    throw protocolError("rootfs transport names another manifest or unsupported version");
  }
  const packs = decodeUserspaceRootfsPacks(input["packs"], rootfsClosure(manifest), base);
  const ranges = new Map(packs.index.chunks.map(chunk => [chunk.sha256, [] as { start: number; end: number }[]]));
  for (const blob of packs.index.blobs) for (const extent of blob.extents) {
    ranges.get(extent.chunk)?.push({ start: extent.offset, end: extent.offset + extent.bytes });
  }
  for (const chunk of packs.index.chunks) {
    let end = 0;
    // Content-identical physical chunks can be shared, so check their union rather than count extents.
    for (const range of (ranges.get(chunk.sha256) ?? []).sort((a, b) => a.start - b.start)) {
      if (range.start > end) throw protocolError("rootfs transport decoded coverage has a gap");
      end = Math.max(end, range.end);
    }
    if (end !== chunk.bytes) throw protocolError("rootfs transport decoded coverage differs from its signed blobs");
  }
  const directory = new URL(".", base);
  for (const artifact of packs.artifacts) {
    const url = artifact.url;
    if (url.origin !== directory.origin || !url.pathname.startsWith(directory.pathname)
      || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "" || url.pathname.includes("%")) {
      throw protocolError("rootfs transport artifact is outside its image directory");
    }
  }
  return packs;
}
