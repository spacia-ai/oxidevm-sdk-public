import { lstat } from "node:fs/promises";
import { Parser } from "tar";
import { integer, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeSHA256 } from "../values.js";
import { decodeBundleJSON } from "./bundle-files.js";
import { hash } from "./files.js";
import { readTarFile } from "./tar-reader.js";
import { abortIfRequested } from "./tools.js";

const INDEX = "application/vnd.oci.image.index.v1+json";
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const CONFIG = "application/vnd.oci.image.config.v1+json";
const STATEMENT = "application/vnd.in-toto+json";
interface Descriptor {
  readonly mediaType: string; readonly digest: string; readonly size: number;
  readonly platform?: { readonly architecture: string; readonly os: string };
  readonly annotations: Readonly<Record<string, string>>;
}
export interface OCIImageEvidence {
  readonly indexSHA256:string;
  readonly configSHA256: string; readonly manifestSHA256: string;
  readonly sbom: Uint8Array<ArrayBuffer>;
  readonly provenance?: unknown;
}
function invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", `OCI build evidence: ${message}`); }
function descriptors(value: unknown): readonly Descriptor[] {
  if (!Array.isArray(value) || value.length > 4096) return invalid("descriptor list exceeds its bound");
  return Array.from<unknown>(value).map(descriptor);
}
function descriptor(value: unknown): Descriptor {
  const input = record(value, "OCI descriptor"); const digest = string(input["digest"], "OCI digest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return invalid("unsupported descriptor digest");
  const annotations: Record<string, string> = {};
  if (input["annotations"] !== undefined) {
    for (const [key, value] of Object.entries(record(input["annotations"], "OCI annotations"))) {
      if (key.length > 4096) return invalid("annotation name exceeds its bound");
      const text = string(value, "OCI annotation"); if (text.length > 8192) return invalid("annotation value exceeds its bound"); annotations[key] = text;
    }
  }
  const platform = input["platform"] === undefined ? undefined : record(input["platform"], "OCI platform");
  return { mediaType: string(input["mediaType"], "OCI media type"), digest, size: integer(input["size"], "OCI blob size", 1, 2 * 1024 ** 3), annotations,
    ...(platform === undefined ? {} : { platform: { architecture: string(platform["architecture"], "OCI architecture"), os: string(platform["os"], "OCI OS") } }) };
}

async function metadataFiles(archive: string, signal?: AbortSignal): Promise<ReadonlyMap<string, Uint8Array<ArrayBuffer>>> {
  const metadata = await lstat(archive);
  if (!metadata.isFile() || metadata.size > 2 * 1024 ** 3) return invalid("archive exceeds its regular-file bound");
  const files = new Map<string, Uint8Array<ArrayBuffer>>(); const paths = new Set<string>(); let total = 0;
  const parser = new Parser({ strict: true, onReadEntry: entry => {
    try {
      abortIfRequested(signal);
      const path = entry.path.replace(/^\.\//u, "").replace(/\/$/u, "");
      if (entry.type === "Directory" && ["blobs", "blobs/sha256"].includes(path)) { entry.resume(); return; }
      if (entry.type !== "File" || !/^(?:index\.json|oci-layout|blobs\/sha256\/[0-9a-f]{64})$/u.test(path) || paths.has(path) || paths.size >= 65536) return invalid("unsupported or duplicate archive member");
      paths.add(path);
      const size = integer(entry.size, "OCI member bytes", 0, 2 * 1024 ** 3);
      const chunks: Buffer[] = []; let received = 0; let retain: boolean | undefined;
      entry.on("data", (value: unknown) => {
        try {
          abortIfRequested(signal);
          if (!(value instanceof Buffer)) return invalid("archive data is not bytes");
          received += value.length;
          if (received > size) return invalid("member exceeds its declared bytes");
          retain ??= path === "index.json" || path === "oci-layout" || value.subarray(0, 64).toString("utf8").trimStart().startsWith("{");
          if (retain) {
            total += value.length;
            if (size > 16 * 1024 ** 2 || total > 64 * 1024 ** 2) return invalid("JSON metadata exceeds its bound");
            chunks.push(value);
          }
        } catch (error) { parser.abort(error instanceof Error ? error : new Error("OCI metadata read failed")); }
      });
      entry.once("end", () => {
        if (retain === true) files.set(path, new Uint8Array(Buffer.concat(chunks)));
      });
      entry.resume();
    } catch (error) { parser.abort(error instanceof Error ? error : new Error("OCI archive validation failed")); }
  } });
  await readTarFile(archive, parser, signal);
  return files;
}

/** Accept attestations only for the exact final linux/amd64 manifest, never another stage. */
export async function readOCIImageEvidence(archive: string, signal?: AbortSignal): Promise<OCIImageEvidence> {
  const files = await metadataFiles(archive, signal);
  function json(path: string): unknown {
    const bytes = files.get(path); if (bytes === undefined) return invalid("referenced JSON blob is absent");
    return decodeBundleJSON(bytes);
  }
  function blob(input: Descriptor): unknown {
    const path = `blobs/sha256/${input.digest.slice(7)}`; const bytes = files.get(path);
    if (bytes === undefined || bytes.length !== input.size || hash(bytes) !== input.digest.slice(7)) return invalid("referenced metadata differs from its descriptor");
    return decodeBundleJSON(bytes);
  }
  function index(value: unknown, depth = 0): readonly Descriptor[] {
    if (depth > 8) return invalid("nested indexes exceed their bound");
    const input = record(value, "OCI index");
    if (input["schemaVersion"] !== 2 || input["mediaType"] !== INDEX) return invalid("invalid OCI index");
    return descriptors(input["manifests"]).flatMap(item => item.mediaType === INDEX ? index(blob(item), depth + 1) : [item]);
  }
  const layout = record(json("oci-layout"), "OCI layout");
  if (layout["imageLayoutVersion"] !== "1.0.0") return invalid("unsupported OCI layout version");
  const manifests = index(json("index.json"));
  const selected = manifests.filter(item => item.mediaType === MANIFEST && item.platform?.os === "linux" && item.platform.architecture === "amd64" && item.annotations["vnd.docker.reference.type"] !== "attestation-manifest");
  const image = selected[0]; if (image === undefined || selected.length !== 1) return invalid("exactly one final linux/amd64 image is required");
  const manifest = record(blob(image), "OCI image manifest");
  if (manifest["schemaVersion"] !== 2 || manifest["mediaType"] !== MANIFEST) return invalid("invalid final image manifest");
  const config = descriptor(manifest["config"]); if (config.mediaType !== CONFIG) return invalid("unsupported image config");
  const configuration = record(blob(config), "OCI image config");
  if (configuration["architecture"] !== "amd64" || configuration["os"] !== "linux") return invalid("image config contradicts the selected platform");
  descriptors(manifest["layers"]);
  let sbom: Uint8Array<ArrayBuffer> | undefined; let provenance: unknown;
  const attestations = manifests.filter(item => item.annotations["vnd.docker.reference.type"] === "attestation-manifest" && item.annotations["vnd.docker.reference.digest"] === image.digest);
  for (const item of attestations) {
    const attestation = record(blob(item), "OCI attestation manifest");
    if (attestation["schemaVersion"] !== 2 || attestation["mediaType"] !== MANIFEST) return invalid("invalid attestation manifest");
    for (const layer of descriptors(attestation["layers"])) {
      if (layer.mediaType !== STATEMENT) return invalid("unsupported attestation media type");
      const statement = record(blob(layer), "in-toto statement");
      if (statement["_type"] !== "https://in-toto.io/Statement/v0.1" && statement["_type"] !== "https://in-toto.io/Statement/v1") return invalid("unsupported in-toto statement");
      const subjects = statement["subject"];
      if (!Array.isArray(subjects) || subjects.length !== 1) return invalid("attestation has ambiguous subjects");
      const subject = record(subjects[0], "attestation subject");
      if (decodeSHA256(record(subject["digest"], "subject digest")["sha256"], "subject digest") !== image.digest.slice(7)) return invalid("attestation describes another stage or image");
      if (statement["predicateType"] === "https://spdx.dev/Document") {
        if (sbom !== undefined) return invalid("duplicate final SPDX attestations");
        const predicate = record(statement["predicate"], "SPDX predicate");
        if (predicate["spdxVersion"] !== "SPDX-2.3") return invalid("unsupported SPDX version");
        sbom = new TextEncoder().encode(JSON.stringify(predicate));
      } else if (statement["predicateType"] === "https://slsa.dev/provenance/v0.2") {
        if (provenance !== undefined) return invalid("duplicate build provenance attestations");
        provenance = statement["predicate"];
      }
    }
  }
  if (sbom === undefined) return invalid("final image has no bound SPDX attestation");
  const indexBytes=files.get("index.json");if(indexBytes===undefined)return invalid("index is missing");
  const roots=descriptors(record(json("index.json"),"OCI root index")["manifests"]),named=roots[0];
  const indexSHA256=roots.length===1&&named?.mediaType===INDEX?named.digest.slice(7):hash(indexBytes);
  return { indexSHA256,configSHA256: config.digest.slice(7), manifestSHA256: image.digest.slice(7), sbom, ...(provenance === undefined ? {} : { provenance }) };
}
