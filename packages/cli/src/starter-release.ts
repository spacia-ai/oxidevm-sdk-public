import { defineImage, VMError } from "@oxidevm/sdk";
import { decodeEngineCompliancePin, decodeImageDigest, getSDKRelease } from "@oxidevm/sdk/image-builder";
import { starterRelease } from "./starter.generated.js";
import { fields, number, object, text } from "./validation.js";

function publicURL(value: unknown): string {
  const url = new URL(text(value));
  if (url.origin !== "https://cdn.oxidevm.dev" || url.username !== "" || url.password !== "" || !url.pathname.startsWith("/images/") || url.search !== "" || url.hash !== "") throw new VMError("PROTOCOL_ERROR", "starter assets must use their pinned public CDN location");
  return url.href;
}

export function decodeStarterRelease(value: unknown, sdkVersion: string, expectedEngine: string) {
  const release = object(value, "starter release"); fields(release, ["schemaVersion", "sdkVersion", "engineRelease", "engineCompliance", "image", "archive", "materialsSHA256", "materialsUrl"]);
  if (release["schemaVersion"] !== 2 || release["sdkVersion"] !== sdkVersion) throw new VMError("PROTOCOL_ERROR", "starter version differs from the installed SDK and CLI version");
  const engine = decodeImageDigest(release["engineRelease"], "starter engine");
  if (`sha256:${engine}` !== expectedEngine) throw new VMError("PROTOCOL_ERROR", "starter engine differs from the installed SDK");
  const location = object(release["image"], "starter image"); fields(location, ["mode", "manifestUrl", "manifestSHA256", "trust"]);
  if (location["mode"] !== "userspace") throw new VMError("PROTOCOL_ERROR", "public starter requires Userspace");
  const trust = object(location["trust"], "starter author trust"); fields(trust, ["algorithm", "keyId", "publicKey"]);
  if (trust["algorithm"] !== "Ed25519") throw new VMError("PROTOCOL_ERROR", "starter author trust requires Ed25519");
  const image = defineImage({ mode: "userspace", manifestUrl: publicURL(location["manifestUrl"]), manifestSHA256: decodeImageDigest(location["manifestSHA256"], "starter image"), trust: { algorithm: "Ed25519", keyId: text(trust["keyId"]), publicKey: text(trust["publicKey"]) } });
  const [, imageRoot, imageId, imageVersion] = new URL(image.manifestUrl).pathname.split("/");
  const materials = new URL(text(release["materialsUrl"]));
  if (imageRoot !== "images" || imageId === undefined || imageVersion === undefined || materials.pathname !== `/spacia-ai/oxidevm-sdk-public/releases/download/image-${imageId}-v${imageVersion}/OPEN-SOURCE-NOTICE.md` || !/^https:\/\/github\.com\/spacia-ai\/oxidevm-sdk-public\/releases\/download\/image-[A-Za-z0-9][A-Za-z0-9._-]*-v[0-9]+\.[0-9]+\.[0-9]+\/OPEN-SOURCE-NOTICE\.md$/u.test(materials.href)) throw new VMError("PROTOCOL_ERROR", "starter materials require their pinned GitHub release");
  const archive = object(release["archive"], "starter archive"); fields(archive, ["url", "bytes", "sha256"]);
  const bytes = number(archive["bytes"], 1); if (bytes > 512 * 1024 ** 2) throw new VMError("PROTOCOL_ERROR", "starter archive exceeds its size limit");
  return { schemaVersion: 2 as const, sdkVersion, engineRelease: engine, engineCompliance: decodeEngineCompliancePin(release["engineCompliance"], engine), image, archive: { url: publicURL(archive["url"]), bytes, sha256: decodeImageDigest(archive["sha256"], "starter archive") }, materialsUrl: materials.href, materialsSHA256: decodeImageDigest(release["materialsSHA256"], "starter license materials") };
}

/** No mutable catalog or private credentials take part in the public quickstart. */
export function pinnedStarterRelease() {
  if (starterRelease === null) return undefined;
  const sdk = getSDKRelease(); return decodeStarterRelease(starterRelease, sdk.sdkVersion, sdk.engineRelease);
}
