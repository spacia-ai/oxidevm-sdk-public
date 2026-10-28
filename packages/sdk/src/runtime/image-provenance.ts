import { isTrustworthyURL } from "../trustworthy-url.js";
import { exactKeys, integer, protocolError, record, string } from "./decode.js";
import { decodeEd25519Signature, verifyEd25519 } from "./ed25519.js";

export interface ImageEvidenceArtifact { readonly url: URL; readonly bytes: number; readonly sha256: string }
export interface ImageProvenance {
  readonly keyId: string; readonly signature: string;
  readonly sbom: ImageEvidenceArtifact; readonly notices: ImageEvidenceArtifact;
  readonly correspondingSources: ImageEvidenceArtifact; readonly reproducibility: ImageEvidenceArtifact;
}
export interface ImageTrust { readonly keyId: string; readonly publicKey: Uint8Array }
const artifactLocations = new WeakMap<URL, { readonly literal: string; readonly resolved: string }>();

/** Preserve signed URL syntax separately from its host-specific fetch resolution. */
export function rememberArtifactURL(url: URL, literal: string): URL {
  artifactLocations.set(url, { literal, resolved: url.href }); return url;
}

export function decodeImageProvenance(value: unknown, base: URL): ImageProvenance {
  const input = record(value, "image provenance");
  exactKeys(input, ["keyId", "signature", "sbom", "notices", "correspondingSources", "reproducibility"]);
  const keyId = string(input["keyId"], "image key ID");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(keyId)) throw protocolError("invalid image key ID");
  const signature = string(input["signature"], "image signature"); decodeEd25519Signature(signature, "image");
  const artifact = (value: unknown): ImageEvidenceArtifact => {
    const source = record(value, "image evidence"); exactKeys(source, ["url", "bytes", "sha256"]);
    const literal = string(source["url"], "evidence URL");
    const url = rememberArtifactURL(new URL(literal, base), literal);
    if (!isTrustworthyURL(url) || url.username !== "" || url.password !== "" || url.hash !== "") throw protocolError("untrustworthy image evidence URL");
    const sha256 = string(source["sha256"], "evidence SHA256");
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw protocolError("invalid evidence digest");
    return { url, bytes: integer(source["bytes"], "evidence size", 1, 8 * 1024 ** 3), sha256 };
  };
  return { keyId, signature, sbom: artifact(input["sbom"]), notices: artifact(input["notices"]), correspondingSources: artifact(input["correspondingSources"]), reproducibility: artifact(input["reproducibility"]) };
}

/** Canonical whole-image identity: sorted object keys and portable artifact serving paths. */
export function canonicalImageBytes(value: unknown, manifestUrl?: URL): Uint8Array<ArrayBuffer> {
  const base = manifestUrl === undefined ? undefined : new URL(".", manifestUrl);
  function canonical(value: unknown): unknown {
    if (value instanceof URL) {
      const location = artifactLocations.get(value);
      if (location !== undefined) {
        if (value.href !== location.resolved) throw protocolError("artifact URL changed after manifest decoding");
        return location.literal;
      }
      if (base !== undefined && value.origin === base.origin && value.pathname.startsWith(base.pathname)) return `./${value.pathname.slice(base.pathname.length)}${value.search}`;
      return base === undefined ? `${value.pathname}${value.search}` : value.href;
    }
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
  }
  return new TextEncoder().encode(JSON.stringify(canonical(value)));
}

export async function verifyImageProvenance(provenance: ImageProvenance | undefined, bytes: Uint8Array<ArrayBuffer>, trusted: ImageTrust): Promise<void> {
  if (provenance === undefined || provenance.keyId !== trusted.keyId) throw protocolError("image does not have trusted whole-image provenance");
  await verifyEd25519(trusted.publicKey.slice(), provenance.signature, bytes, "image");
}
