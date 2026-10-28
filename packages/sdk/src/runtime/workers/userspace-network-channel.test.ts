import { afterEach, describe, expect, it, vi } from "vitest";

import { UserspaceNetworkClient, serveUserspaceNetwork } from "./userspace-network-channel.js";

describe("Userspace network capability channel", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps local mode fail-closed without touching external transport", async () => {
    const channel = new MessageChannel();
    serveUserspaceNetwork(channel.port2);
    const client = new UserspaceNetworkClient(channel.port1);
    await expect(client.request({
      kind: "network",
      generation: 1n,
      id: 1n,
      operation: {
        kind: "connect",
        socket: 1n,
        family: 2,
        address: new Uint8Array([93, 184, 216, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        port: 443,
      },
    })).resolves.toEqual({ kind: "error", errno: 1 });
    client.close();
  });

  it("rejects reserved destinations before relay bootstrap", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const channel = new MessageChannel();
    serveUserspaceNetwork(channel.port2);
    const client = new UserspaceNetworkClient(channel.port1);
    await expect(client.request({
      kind: "network",
      generation: 1n,
      id: 2n,
      operation: {
        kind: "connect",
        socket: 1n,
        family: 2,
        address: new Uint8Array([127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        port: 80,
      },
    })).resolves.toEqual({ kind: "error", errno: 1 });
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it("blocks reserved IPv4, IPv6, and ports before relay bootstrap", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const channel = new MessageChannel();
    serveUserspaceNetwork(channel.port2);
    const client = new UserspaceNetworkClient(channel.port1);
    const destinations: Array<{ family: 2 | 10; address: Uint8Array; port: number }> = [
      { family: 2, address: new Uint8Array([10, 0, 0, 1, ...new Uint8Array(12)]), port: 443 },
      { family: 2, address: new Uint8Array([93, 184, 216, 34, ...new Uint8Array(12)]), port: 22 },
      { family: 10, address: new Uint8Array([0xfe, 0x80, ...new Uint8Array(14)]), port: 443 },
      { family: 10, address: new Uint8Array([0x20, 0x01, 0x0d, 0xb8, ...new Uint8Array(12)]), port: 443 },
    ];
    for (const [index, destination] of destinations.entries()) {
      await expect(client.request({
        kind: "network",
        generation: 1n,
        id: BigInt(index + 10),
        operation: { kind: "connect", socket: BigInt(index + 1), ...destination },
      })).resolves.toEqual({ kind: "error", errno: 1 });
    }
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });
});

it("acknowledges enable and revocation before SDK readiness, without touching preview callbacks", async () => {
  const channel = new MessageChannel();
  const server = serveUserspaceNetwork(channel.port2);
  const configure = vi.fn(() => Promise.resolve());
  const client = new UserspaceNetworkClient(channel.port1, configure);
  await server.setRelay(undefined, 2);
  expect(configure).toHaveBeenCalledWith(false, 2);
  client.close(); server.close();
});
