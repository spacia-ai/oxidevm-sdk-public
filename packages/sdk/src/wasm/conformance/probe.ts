import type { EndpointDecl, ResolvedManifest } from "../manifest-types.js";
import { decodeResolvedManifest } from "../manifest.js";
import { moduleHandle, type ModuleHandle } from "../handle.js";

/**
 * A command module of the harness itself: it opens and closes one connection to each endpoint it is given,
 * through the same runner and engine sockets a real client uses, so no guest program is needed. It writes
 * `refused <target>` for each endpoint it could not reach and exits 1 if there was any.
 */
export const PROBE_ADAPTER = `export default host => ({ async main(io) {
  let refused = 0;
  for (const target of io.args) {
    const unix = target.startsWith("unix:");
    try {
      const fd = await host.sockets.socket(unix ? "unix" : "ipv4");
      try { await host.sockets.connect(fd, unix ? { family: "unix", path: target.slice(5) } : { family: "ipv4", address: "127.0.0.1", port: Number(target.slice(4)) }); }
      finally { await host.sockets.close(fd); }
    } catch (error) {
      refused += 1;
      host.log("refused " + target + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return refused === 0 ? 0 : 1;
} });
`;

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The probe's handle, pinned to the sha256 of its own source and served as a bounded data URL. */
export async function probeHandle(): Promise<ModuleHandle<ResolvedManifest>> {
  const bytes = new TextEncoder().encode(PROBE_ADAPTER);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const manifest = decodeResolvedManifest({
    schemaVersion: 1, id: "oxidevm-endpoint-probe", version: "1.0.0", abi: "raw", adapter: { api: 1, sha256, bytes: bytes.length }, artifacts: [],
    process: { kind: "command" }, requires: { host: ["sockets.connect"] }, license: { spdx: "Apache-2.0" },
  });
  const url = `data:text/javascript;base64,${btoa(String.fromCharCode(...bytes))}`;
  return moduleHandle(manifest, { release: sha256, adapter: { url, sha256, bytes: bytes.length }, artifacts: {} });
}

/** The probe's arguments for a set of endpoints, and the endpoint name behind each argument. */
export function probeTargets(endpoints: Readonly<Record<string, EndpointDecl>>): readonly { readonly name: string; readonly target: string }[] {
  return Object.entries(endpoints).map(([name, endpoint]) => ({ name, target: endpoint.kind === "unix" ? `unix:${endpoint.path}` : `tcp:${String(endpoint.port)}` }));
}

/** The endpoint names the probe reported as refused, read from its standard error. */
export function refusedEndpoints(targets: ReturnType<typeof probeTargets>, stderr: string): readonly string[] {
  const refused = new Set(stderr.split("\n").flatMap(line => line.startsWith("refused ") ? [line.slice("refused ".length).split(": ")[0] ?? ""] : []));
  return targets.filter(entry => refused.has(entry.target)).map(entry => entry.name);
}
