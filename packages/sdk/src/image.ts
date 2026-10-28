import {exactKeys, record, string} from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";
import { decodeSHA256 } from "./values.js";
import type { CPUProfile, RuntimeMode, SHA256 } from "./values.js";

const imageRefBrand = Symbol("oxidevm.image-ref");
const imageRefs = new WeakSet<object>();
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

export interface TrustedImageKey {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly publicKey: string;
}

export interface ImageLocation<M extends RuntimeMode> {
  readonly mode: M;
  readonly manifestUrl: string | URL;
  readonly manifestSHA256: string;
  readonly trust: TrustedImageKey;
}

export interface ImageRef<M extends RuntimeMode> {
  readonly [imageRefBrand]: M;
  readonly mode: M;
  readonly manifestUrl: string;
  readonly manifestSHA256: SHA256;
  readonly trust: TrustedImageKey;
}

export interface ImageInfo {
  readonly id: string;
  readonly version: string;
  readonly mode: RuntimeMode;
  readonly manifestSHA256: SHA256;
  readonly cpuProfile: CPUProfile;
  readonly signatureVerified: true;
  readonly keyId: string;
}

/** Pin location and author trust without reading browser state or downloading bytes. */
export function defineImage<M extends RuntimeMode>(location: ImageLocation<M>): ImageRef<M> {
  const source = inputRecord(location, "image location");
  exactFields(source, ["mode", "manifestUrl", "manifestSHA256", "trust"], "image location");
  const mode = location.mode;
  if (source["mode"] !== "system" && source["mode"] !== "userspace") invalid("image mode must be system or userspace");
  const trust = decodeTrustedImageKey(source["trust"]);
  const image = Object.freeze({
    [imageRefBrand]: mode,
    mode,
    manifestUrl: decodeImageLocation(source["manifestUrl"]),
    manifestSHA256: decodeSHA256(source["manifestSHA256"], "manifestSHA256"),
    trust: Object.freeze(trust),
  });
  imageRefs.add(image);
  return image;
}

export function isImageRef<M extends RuntimeMode>(value: unknown, mode: M): value is ImageRef<M> {
  return isRecord(value) && imageRefs.has(value) && value["mode"] === mode;
}

/** The raw public key accepted by the existing manifest verifier. */
export function imagePublicKeyBytes(trust: TrustedImageKey): Uint8Array<ArrayBuffer> {
  return decodeSPKI(trust.publicKey).slice(ED25519_SPKI_PREFIX.length);
}

export function decodeTrustedImageKey(value: unknown): TrustedImageKey {
  const source = inputRecord(value, "image trust");
  exactFields(source, ["algorithm", "keyId", "publicKey"], "image trust");
  if (source["algorithm"] !== "Ed25519") invalid("image trust algorithm must be Ed25519");
  const keyId = source["keyId"];
  if (typeof keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyId)) invalid("image keyId must be a bounded identifier");
  const publicKey = source["publicKey"];
  decodeSPKI(publicKey);
  if (typeof publicKey !== "string") invalid("image publicKey must be base64 SPKI");
  return { algorithm: "Ed25519", keyId, publicKey };
}

function decodeSPKI(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length !== 60 || !/^[A-Za-z0-9+/]{59}=$/u.test(value)) invalid("image publicKey must encode Ed25519 SPKI");
  let binary: string;
  try { binary = atob(value); } catch { return invalid("image publicKey has invalid base64"); }
  if (binary.length !== 44 || btoa(binary) !== value) invalid("image publicKey has noncanonical SPKI encoding");
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (ED25519_SPKI_PREFIX.some((byte, index) => bytes[index] !== byte)) invalid("image publicKey must use the Ed25519 SPKI algorithm");
  return bytes;
}

export function decodeImageLocation(value: unknown): string {
  const text = value instanceof URL ? value.href : value;
  if (typeof text !== "string" || text.length === 0 || text.length > 8192 || Array.from(text).some(char => char.charCodeAt(0) <= 32 || char === "\\")) invalid("manifestUrl must be a bounded HTTP URL or origin-relative path");
  let url: URL;
  try { url = new URL(text, "https://oxidevm-reference.invalid/"); } catch { return invalid("manifestUrl is invalid"); }
  const originRelative = text.startsWith("/") && !text.startsWith("//");
  if (!originRelative && !/^https?:\/\//u.test(text)) invalid("manifestUrl must be HTTP(S) or origin-relative");
  if (url.username !== "" || url.password !== "") invalid("manifestUrl must not contain credentials");
  const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/u.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) invalid("manifestUrl must use a trustworthy origin");
  let path: string;
  try { path = decodeURIComponent(text.split(/[?#]/u)[0] ?? ""); } catch { return invalid("manifestUrl has invalid path encoding"); }
  if (path.split("/").some(segment => segment === "." || segment === "..")) invalid("manifestUrl must not contain ambiguous path traversal");
  return originRelative ? text : url.href;
}

function inputRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) invalid(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(source: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  if (fields.some(field => !Object.hasOwn(source, field)) || Object.keys(source).some(field => !fields.includes(field))) invalid(`${label} has invalid fields`);
}

function invalid(message: string): never {
  throw new VMError("INVALID_ARGUMENT", message);
}

export function decodeImageInfo(value: unknown): ImageInfo {
  const info = record(value, "image info");
  exactKeys(info, ["id", "version", "mode", "manifestSHA256", "cpuProfile", "signatureVerified", "keyId"]);
  const mode = info["mode"];
  const cpuProfile = info["cpuProfile"];
  if ((mode !== "system" && mode !== "userspace") || (cpuProfile !== "x86-64-v2" && cpuProfile !== "x86-64-v3") || info["signatureVerified"] !== true) {
    throw new VMError("PROTOCOL_ERROR", "image info is invalid");
  }
  return {
    id: identityText(info["id"], "image id", 256), version: identityText(info["version"], "image version", 256), mode,
    manifestSHA256: decodeSHA256(info["manifestSHA256"], "manifestSHA256"), cpuProfile, signatureVerified: true,
    keyId: identityText(info["keyId"], "image key id", 128),
  };
}

function identityText(value:unknown,label:string,max:number):string { const text=string(value,label); if(text.length===0||text.length>max) throw new VMError("PROTOCOL_ERROR",`${label} is invalid`);return text; }
