import { fileURLToPath } from "node:url";
import { exactKeys, integer, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import type { RuntimeMode } from "../values.js";
import { decodeBundleJSON, readBundleFile } from "./bundle-files.js";
import type { DownloadArtifact } from "./download.js";

export interface BootstrapFile { readonly name: "kernel" | "agent" | "init"; readonly bytes: number; readonly sha256: string }
interface CatalogImage { readonly mode: RuntimeMode; readonly manifestSHA256: string; readonly archive: DownloadArtifact }
interface CatalogBootstrap { readonly identity: string; readonly archive: DownloadArtifact; readonly files: readonly BootstrapFile[] }
export type ReleaseCatalog =
  | { readonly schemaVersion: 2; readonly sdkVersion: string; readonly images: readonly CatalogImage[]; readonly bootstrap: CatalogBootstrap }
  | { readonly schemaVersion: 3; readonly sdkVersion: string; readonly images: readonly []; readonly bootstrap: null };
function sha(value: unknown): string { const digest = string(value, "release digest"); if (!/^[a-f0-9]{64}$/u.test(digest)) throw new VMError("PROTOCOL_ERROR", "invalid release digest"); return digest; }
function artifact(value: unknown): DownloadArtifact {
  const input = record(value, "release archive"); exactKeys(input, ["url", "bytes", "sha256"]);
  const url = new URL(string(input["url"], "release URL"));
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new VMError("PROTOCOL_ERROR", "release URL requires HTTPS without credentials");
  return { url: url.href, bytes: integer(input["bytes"], "release bytes", 1, 2 * 1024 ** 3), sha256: sha(input["sha256"]) };
}
export function decodeReleaseCatalog(value: unknown): ReleaseCatalog {
  const input = record(value, "release catalog"); exactKeys(input, ["schemaVersion", "sdkVersion", "images", "bootstrap"]);
  if (input["schemaVersion"] === 3) {
    if (!Array.isArray(input["images"]) || input["images"].length !== 0 || input["bootstrap"] !== null) throw new VMError("PROTOCOL_ERROR", "explicit-image catalog cannot contain managed images or integration");
    return { schemaVersion: 3, sdkVersion: string(input["sdkVersion"], "release SDK"), images: [], bootstrap: null };
  }
  if (input["schemaVersion"] !== 2 || !Array.isArray(input["images"]) || input["images"].length !== 2) throw new VMError("PROTOCOL_ERROR", "release catalog requires both image modes");
  const images = Array.from<unknown>(input["images"]).map((value): CatalogImage => {
    const item = record(value, "release image"); exactKeys(item, ["mode", "manifestSHA256", "archive"]); const mode = item["mode"];
    if (mode !== "system" && mode !== "userspace") throw new VMError("PROTOCOL_ERROR", "invalid catalog image mode");
    return { mode, manifestSHA256: sha(item["manifestSHA256"]), archive: artifact(item["archive"]) };
  });
  if (new Set(images.map(item => item.mode)).size !== 2) throw new VMError("PROTOCOL_ERROR", "duplicate catalog mode");
  const bootstrap = record(input["bootstrap"], "managed integration"); exactKeys(bootstrap, ["identity", "archive", "files"]);
  if (!Array.isArray(bootstrap["files"]) || bootstrap["files"].length !== 3) throw new VMError("PROTOCOL_ERROR", "managed integration requires kernel, agent and init");
  const files = Array.from<unknown>(bootstrap["files"]).map((value): BootstrapFile => {
    const item = record(value, "integration artifact"); exactKeys(item, ["name", "bytes", "sha256"]); const name = item["name"];
    if (name !== "kernel" && name !== "agent" && name !== "init") throw new VMError("PROTOCOL_ERROR", "invalid integration artifact name");
    return { name, bytes: integer(item["bytes"], "integration bytes", 1, 128 * 1024 ** 2), sha256: sha(item["sha256"]) };
  });
  if (new Set(files.map(file => file.name)).size !== 3) throw new VMError("PROTOCOL_ERROR", "duplicate integration artifact");
  return { schemaVersion: 2, sdkVersion: string(input["sdkVersion"], "release SDK"), images, bootstrap: { identity: sha(bootstrap["identity"]), archive: artifact(bootstrap["archive"]), files } };
}
export async function readReleaseCatalog(): Promise<ReleaseCatalog> {
  const assets = fileURLToPath(new URL("../../assets/", import.meta.url));
  return decodeReleaseCatalog(decodeBundleJSON(await readBundleFile(assets, "image-catalog.json", 64 * 1024)));
}
