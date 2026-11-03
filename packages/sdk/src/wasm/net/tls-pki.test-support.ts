import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A server identity: its key and certificate chain in PEM. */
export interface Identity { readonly key: string; readonly cert: string }

/**
 * A throwaway test PKI, generated per call with `openssl` (3.4 or newer) so no private key lives in Git: a root that plays
 * the VM's `/etc/ssl/cert.pem`, a server for `tls.test` it issued, one for another name, an expired one, and one issued
 * by a root the VM does not trust.
 */
export interface TestPki {
  readonly root: string;
  /** The root that issued `unknown`, which the VM does not trust: a program's private CA file. */
  readonly strangerRoot: string;
  readonly server: Identity;
  readonly mismatch: Identity;
  readonly expired: Identity;
  readonly unknown: Identity;
}

export async function createTestPki(): Promise<TestPki> {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-tls-pki-"));
  const path = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => run("openssl", args, { timeout: 30_000, cwd: directory });
  const key = (name: string) => openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", path(`${name}.key`));
  const root = async (name: string, subject: string) => {
    await key(name);
    await openssl("req", "-x509", "-new", "-key", path(`${name}.key`), "-subj", `/CN=${subject}`, "-days", "30",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", path(`${name}.pem`));
  };
  const leaf = async (name: string, issuer: string, dns: string, window: readonly string[]): Promise<Identity> => {
    await key(name);
    await openssl("req", "-new", "-key", path(`${name}.key`), "-subj", `/CN=${dns}`, "-out", path(`${name}.csr`));
    await writeFile(path(`${name}.ext`), `subjectAltName=DNS:${dns}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n`);
    await openssl("x509", "-req", "-in", path(`${name}.csr`), "-CA", path(`${issuer}.pem`), "-CAkey", path(`${issuer}.key`), "-set_serial", `0x${String(Date.now())}${name.length.toString(16)}`,
      ...window, "-extfile", path(`${name}.ext`), "-out", path(`${name}.pem`));
    return { key: await readFile(path(`${name}.key`), "utf8"), cert: await readFile(path(`${name}.pem`), "utf8") };
  };
  try {
    await root("root", "OxideVM SDK TLS Test Root");
    await root("stranger", "OxideVM SDK TLS Test Stranger");
    const valid = ["-days", "30"];
    return {
      root: await readFile(path("root.pem"), "utf8"),
      strangerRoot: await readFile(path("stranger.pem"), "utf8"),
      server: await leaf("server", "root", "tls.test", valid),
      mismatch: await leaf("mismatch", "root", "other.test", valid),
      expired: await leaf("expired", "root", "tls.test", ["-not_before", "20200101000000Z", "-not_after", "20210101000000Z"]),
      unknown: await leaf("unknown", "stranger", "tls.test", valid),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
