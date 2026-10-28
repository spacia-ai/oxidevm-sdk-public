import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { VMError } from "../runtime/errors.js";
import { decodeTrustedImageKey } from "../image.js";
import type { TrustedImageKey } from "../image.js";
import { hash,readSourceFile } from "./files.js";

export function publicTrust(key: KeyObject): TrustedImageKey {
  if (key.asymmetricKeyType !== "ed25519") throw new VMError("INVALID_ARGUMENT", "signing key must be Ed25519");
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return { algorithm: "Ed25519", keyId: `ed25519-${hash(spki).slice(0, 32)}`, publicKey: spki.toString("base64") };
}
export async function loadSigningKey(path: string): Promise<{ readonly key: KeyObject; readonly trust: TrustedImageKey }> {
  const pem = new TextDecoder().decode((await readSourceFile(path,64*1024)).bytes);
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) throw new VMError("INVALID_ARGUMENT", "signing key must use PKCS#8 PEM");
  let key: KeyObject;
  try { key = createPrivateKey(pem); } catch { throw new VMError("INVALID_ARGUMENT", "signing key is not valid PKCS#8"); }
  return { key, trust: publicTrust(key) };
}
export async function generateImageKey(out: string): Promise<{ readonly privateKeyPath: string; readonly publicKeyPath: string; readonly trust: TrustedImageKey }> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const trust = publicTrust(privateKey); const companion = `${out.replace(/\.pem$/u, "")}.public.json`;
  await writeFile(companion, `${JSON.stringify(trust, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  try { await writeFile(out, privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 }); }
  catch (error) { await rm(companion); throw error; }
  return { privateKeyPath: out, publicKeyPath: companion, trust };
}
export async function readImageTrust(path: string): Promise<TrustedImageKey> {
  const value: unknown = JSON.parse(new TextDecoder().decode((await readSourceFile(path,8192)).bytes)) as unknown;
  if (typeof value !== "object" || value === null || !("algorithm" in value) || value.algorithm !== "Ed25519" || !("keyId" in value) || typeof value.keyId !== "string" || !("publicKey" in value) || typeof value.publicKey !== "string" || Object.keys(value).length !== 3) throw new VMError("INVALID_ARGUMENT", "trust file must contain Ed25519 public trust metadata");
  return decodeTrustedImageKey({ algorithm: value.algorithm, keyId: value.keyId, publicKey: value.publicKey });
}
