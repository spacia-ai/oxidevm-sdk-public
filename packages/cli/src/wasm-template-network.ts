// The module networking standard in generated projects (engine ADR 0029, N-1 to N-10): the reach a module declares, its
// README section and AGENTS.md rules, and for a module with a reach a small request helper with its tests.

/** How far a generated module reaches on the network; `oxidevm wasm init --network`. */
export type TemplateReach = "none" | "vm" | "internet";
export const TEMPLATE_REACHES: readonly TemplateReach[] = ["none", "vm", "internet"];

/** The `requires.host` token of a reach, or none. */
export function reachToken(reach: TemplateReach): "net.vm" | "net.internet" | undefined {
  return reach === "vm" ? "net.vm" : reach === "internet" ? "net.internet" : undefined;
}

/** The disclosure an internet module starts with (N-2): shown at install and by `oxidevm wasm doctor`, never enforced. */
export const NETWORK_DISCLOSURE = `    network: { purpose: "Describe in one sentence what this module contacts on the internet, and why." },\n`;

/** `src/net.ts` of a module with a reach: one bounded request, cancelled with the module, that throws on failure. */
export const NET_SOURCE = `import type { BaseHost } from "@oxidevm/sdk/wasm";

/** How long one request may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** The most bytes one answer may have. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/**
 * Fetches \`url\` as text through the module's VM network (the runner's \`fetch\`), cancelled with the module
 * (\`host.signal\`) or after REQUEST_TIMEOUT_MS, and bounded to MAX_ANSWER_BYTES. It throws on failure: a command prints
 * \`host.kit.net.describe(error, argv0)\` and returns \`MODULE_EXIT.unavailable\` (69); a service fails only that request.
 */
export async function fetchText(host: Pick<BaseHost, "signal">, url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.any([host.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
  if (!response.ok) throw new Error(\`\${url} answered HTTP \${String(response.status)}\`);
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader(), decoder = new TextDecoder();
  let text = "", total = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    total += part.value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new Error(\`\${url} answered more than \${String(MAX_ANSWER_BYTES)} bytes\`);
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}
`;

/** `test/net.test.ts`: the helper through the SDK's real runner and fake network (\`testHost\`). */
export function netTest(reach: "vm" | "internet"): string {
  const token = reachToken(reach) ?? "net.vm";
  const reached = reach === "internet"
    ? `  it("answers through the VM's connection", async () => {
    const result = await testHost(probe, { args: ["https://api.example.com/hello"], net: { connected: true, http: { "https://api.example.com": request => new Response(\`hello from \${new URL(request.url).pathname}\`) } } }).run();
    expect(result).toMatchObject({ status: 0, stderr: "hello from /hello\\n" });
  });

  it("fails with one line and status 69 while the VM is not connected", async () => {
    const result = await testHost(probe, { args: ["https://api.example.com/hello"] }).run();
    expect(result).toMatchObject({ status: MODULE_EXIT.unavailable, stderr: "net-probe: network unavailable: this VM is not connected to the internet\\n" });
  });
`
    : `  it("reaches a program in this VM, also while the VM is not connected to the internet", async () => {
    const result = await testHost(probe, { args: ["http://vm:8080/hello"], net: { vm: { 8080: request => new Response(\`hello from \${new URL(request.url).pathname}\`) } } }).run();
    expect(result).toMatchObject({ status: 0, stderr: "hello from /hello\\n" });
  });

  it("is refused beyond the VM, with one line and status 69", async () => {
    const result = await testHost(probe, { args: ["https://93.184.216.34/"], net: { connected: true } }).run();
    expect(result.status).toBe(MODULE_EXIT.unavailable);
    expect(result.stderr).toContain("net-probe: network refused: 93.184.216.34 is beyond this module's declared network reach\\n");
  });
`;
  const violation = reach === "internet"
    ? `
  it("a module that declares only net.vm is refused beyond the VM", async () => {
    const vmOnly = defineModule({ manifest: { ...probe.manifest, id: "net-probe-vm", requires: { host: ["net.vm"] } }, adapter: probe.adapter });
    const result = await testHost(vmOnly, { args: ["https://93.184.216.34/"], net: { connected: true } }).run();
    expect(result.status).toBe(MODULE_EXIT.unavailable);
    expect(result.stderr).toContain("network refused: 93.184.216.34 is beyond this module's declared network reach");
  });
`
    : "";
  return `import { describe, expect, it } from "vitest";
import { defineModule, MODULE_EXIT } from "@oxidevm/sdk/wasm";
import { testHost } from "@oxidevm/sdk/wasm/testing";
import { fetchText } from "../src/net.ts";

/** A command that prints what fetchText answers for its argument, the way the module's own code uses it. */
const probe = defineModule({
  manifest: {
    id: "net-probe", version: "0.1.0", abi: "raw", artifacts: [], process: { kind: "command" },
    requires: { host: [${JSON.stringify(token)}] }, license: { spdx: "Apache-2.0" },
  },
  adapter: host => ({
    main: async io => {
      try {
        host.log(await fetchText(host, io.args[0] ?? ""));
        return 0;
      } catch (error: unknown) {
        host.log(host.kit.net.describe(error, "net-probe"));
        return MODULE_EXIT.unavailable;
      }
    },
  }),
});

describe("fetchText", () => {
${reached}${violation}
  it("is cancelled with the module", async () => {
    await expect(fetchText({ signal: AbortSignal.abort() }, "https://api.example.com/")).rejects.toMatchObject({ name: "AbortError" });
  });
});
`;
}

/** The README's "Network" section (N-10): the reach, the disclosure, and what happens offline. */
export function networkSection(reach: TemplateReach): string {
  const body = reach === "none"
    ? `This module declares no network reach: it opens no connections of its own
and its \`fetch\` fails with "network not declared". A service still serves programs in the VM through \`expose\`.`
    : reach === "vm"
      ? `This module reaches programs in its own VM only (\`net.vm\`): loopback, Unix sockets and the VM's own addresses, with names from the VM's \`/etc/hosts\`. It works the same whether or not the VM is connected to the internet. A connection beyond the VM fails with \`EACCES\`.`
      : `This module reaches the internet through the VM's connection (\`net.internet\`): public hosts on TCP 80 and 443, with DNS through the VM's resolver and TLS verified against the VM's \`/etc/ssl/cert.pem\`.

- Hosts it contacts by default, and why: see \`network\` in \`module.ts\` (shown at install; not an allowlist).
- Until the application connects the VM (\`vm.network.connect\`), and after the user revokes it, a request fails. A command then prints one line (\`network unavailable: this VM is not connected to the internet\`) and exits 69; a service fails only that request and stays ready.`;
  return `
## Network

${body}
`;
}

/** AGENTS.md "Networking rules": ADR 0029, N-1 to N-10, condensed. */
export const NETWORK_RULES = `
## Networking rules

The module networking standard (OxideVM engine ADR 0029; the SDK's \`docs/wasm-modules.md\`, "Networking"):

1. Declare one reach in \`requires.host\`: none, \`net.vm\` or \`net.internet\`. Rust enforces it for every process of the module.
2. With \`net.internet\`, disclose default hosts and the purpose in \`network\`; it is shown at install and never an allowlist.
3. Use only the host's network: \`fetch\`, \`WebSocket\`, \`host.net\`. \`XMLHttpRequest\`, \`EventSource\`, \`sendBeacon\`, WebRTC, WebTransport and remote \`import()\` or \`importScripts\` do not exist in module workers.
4. Adapt a runtime's own network layer with \`host.kit.emscripten.network\` or \`host.kit.tls\`; never bypass the host.
5. Offline or revoked, a command prints one line from \`host.kit.net.describe(error, argv0)\` and returns \`MODULE_EXIT.unavailable\` (69); a service fails only the affected request. Never retry in a loop.
6. Every request carries \`host.signal\` (or a signal derived from it) and a timeout; read bodies as streams or bounded.
7. TLS always verifies against the VM's \`/etc/ssl/cert.pem\`. Credentials come only from options or guest files.
8. Internet means TCP 80 and 443 plus DNS; nothing connects in. Programs started with \`process.spawn\` follow the VM's own policy.
9. Test with \`testHost\` from \`@oxidevm/sdk/wasm/testing\` (local-only by default); \`oxidevm wasm test\` checks \`network-direct\`, \`network-declared\` and \`network-offline\`.
10. Keep the README's "Network" section true: reach, disclosed hosts, purpose, and behaviour offline.
`;
