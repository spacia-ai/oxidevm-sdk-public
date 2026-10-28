import { ed25519 } from "@noble/curves/ed25519.js";
import { protocolError } from "./decode.js";

/** The bytes of an Ed25519 signature. */
const SIGNATURE_BYTES = 64;

// WebKit's libgcrypt backend embeds the entire message in a length-limited
// S-expression. Large valid manifests can terminate the renderer instead of
// rejecting the promise. Keep native verification below a conservative 32 KiB
// boundary and verify larger messages with the same strict Ed25519 contract.
// https://github.com/WebKit/WebKit/blob/main/Source/WebCore/crypto/gcrypt/CryptoAlgorithmEd25519GCrypt.cpp
const NATIVE_MESSAGE_BYTES = 32 * 1024;

/**
 * Throws unless `signature`, 64 bytes in base64url, is `publicKey`'s Ed25519 signature of
 * `message`. `subject` names what was signed in the errors.
 */
export async function verifyEd25519(
  publicKey: Uint8Array<ArrayBuffer>,
  signature: string,
  message: Uint8Array<ArrayBuffer>,
  subject: string,
): Promise<void> {
  const signatureBytes = decodeEd25519Signature(signature, subject);
  if (message.byteLength > NATIVE_MESSAGE_BYTES) {
    if (!ed25519.verify(signatureBytes, message, publicKey, { zip215: false })) {
      throw protocolError(`${subject} signature is invalid`);
    }
    return;
  }
  const key = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, signatureBytes, message)) {
    throw protocolError(`${subject} signature is invalid`);
  }
}

/** The 64 bytes of a base64url Ed25519 signature of `subject`. */
export function decodeEd25519Signature(value: string, subject: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw protocolError(`${subject} signature is not base64url`);
  try {
    const decoded = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== SIGNATURE_BYTES) throw new Error();
    return decoded;
  } catch {
    throw protocolError(`${subject} signature has an invalid length`);
  }
}
