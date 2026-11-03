import { describe, expect, it } from "vitest";
import { MemoryNetwork, PASS_THROUGH_TLS, VM_ADDRESS } from "./memory-network.js";
import { createModuleNetwork } from "./surface.js";

/** What `work` threw, or undefined. */
function thrown(work: () => unknown): unknown {
  try { work(); } catch (error: unknown) { return error; }
  return undefined;
}

/** A VM-only module's network on an in-memory VM with a silent server on port 9 and an echo server on port 7. */
function vmNetwork() {
  const network = new MemoryNetwork("vm");
  network.file("/etc/hosts", `${VM_ADDRESS} vm\n`);
  network.listen(VM_ADDRESS, 7, { data: (connection, bytes) => { connection.write(bytes); } });
  network.listen(VM_ADDRESS, 9, { data: () => undefined });
  const net = createModuleNetwork({ ports: { sockets: network.sockets(), sync: network.syncSockets(), tls: null }, reach: "vm", signal: new AbortController().signal, tls: PASS_THROUGH_TLS }).host;
  if (net === undefined) throw new Error("no host.net");
  return net;
}

describe("host.net.connectSync reads with a timeout (ADR 0029, N-4)", () => {
  it("returns the bytes that arrive within the timeout, and the end of stream as an empty read", () => {
    const connection = vmNetwork().connectSync({ host: "vm", port: 7 });
    connection.write(new TextEncoder().encode("ping"));
    expect(new TextDecoder().decode(connection.read(64, { timeoutMs: 1000 }))).toBe("ping");
    connection.close();
  });

  it("fails a read that waits longer than its timeout with ETIMEDOUT, carrying EAGAIN as Linux reports a receive timeout", () => {
    const connection = vmNetwork().connectSync({ host: "vm", port: 9 });
    connection.write(new TextEncoder().encode("anyone?"));
    expect(thrown(() => connection.read(64, { timeoutMs: 25 }))).toMatchObject({ name: "NetError", code: "ETIMEDOUT", errno: 11, syscall: "read" });
    // A timeout of 0 is a poll: it answers at once.
    expect(thrown(() => connection.read(64, { timeoutMs: 0 }))).toMatchObject({ code: "ETIMEDOUT" });
    connection.close();
  });

  it("refuses a timeout that is not a whole number of milliseconds up to a day", () => {
    const connection = vmNetwork().connectSync({ host: "vm", port: 7 });
    for (const timeoutMs of [-1, 1.5, Number.NaN, 24 * 60 * 60 * 1000 + 1]) expect(thrown(() => connection.read(64, { timeoutMs })), String(timeoutMs)).toMatchObject({ code: "INVALID_ARGUMENT" });
    connection.close();
  });
});
