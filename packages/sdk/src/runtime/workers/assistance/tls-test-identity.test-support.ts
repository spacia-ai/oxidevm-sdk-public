import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TLSTestIdentity {
  readonly key: string;
  readonly cert: string;
}

// Generates a throwaway self-signed localhost identity per call. Nothing is committed,
// so no private key lives in Git, packages or history. Requires `openssl` on PATH.
export async function createTLSTestIdentity(): Promise<TLSTestIdentity> {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-tls-identity-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  try {
    await run("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "30",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { timeout: 30_000 });
    return { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
