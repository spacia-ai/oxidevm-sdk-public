import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { expect, it } from "vitest";
import { createTLSTestIdentity } from "./tls-test-identity.test-support.js";

it("creates a fresh localhost identity whose key matches its certificate", async () => {
  const identity = await createTLSTestIdentity();
  const certificate = new X509Certificate(identity.cert);
  expect(identity.key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  expect(certificate.subject).toBe("CN=localhost");
  expect(certificate.subjectAltName).toBe("DNS:localhost, IP Address:127.0.0.1");
  expect(certificate.checkPrivateKey(createPrivateKey(identity.key))).toBe(true);
  expect(createPublicKey(identity.key).export({ format: "pem", type: "spki" })).toBe(certificate.publicKey.export({ format: "pem", type: "spki" }));
});

it("issues a different key on every call so no committed identity is reused", async () => {
  const [first, second] = [await createTLSTestIdentity(), await createTLSTestIdentity()];
  expect(first.key).not.toBe(second.key);
});
