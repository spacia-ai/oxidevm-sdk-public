import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAnswer, DNS_TYPE, encodeQuery } from "./dns.js";
import { dnsAnswerer } from "./dns-server.js";
import { MemoryNetwork } from "./memory-network.js";
import { candidates, hostsAddresses, parseResolvConf, resolve, resolveSync } from "./resolver.js";

function network(reach: "vm" | "internet" = "internet", conf = "nameserver 10.0.2.3\nsearch corp.example\n") {
  const net = new MemoryNetwork(reach);
  net.file("/etc/resolv.conf", conf);
  net.file("/etc/hosts", "127.0.0.1 localhost\n10.0.2.15 vm.local vm # this VM\n");
  net.state = "connected";
  return net;
}

afterEach(() => { vi.useRealTimers(); });

describe("the VM resolver (ADR 0029)", () => {
  it("reads resolv.conf as glibc does: three nameservers, the last search line, options", () => {
    expect(parseResolvConf("nameserver 1.1.1.1\nnameserver ::1\nnameserver bogus\nnameserver 8.8.8.8\nnameserver 9.9.9.9\ndomain a.test\nsearch b.test c.test # comment\noptions ndots:2 timeout:1 attempts:9\n"))
      .toEqual({ nameservers: ["1.1.1.1", "::1", "8.8.8.8"], search: ["b.test", "c.test"], ndots: 2, timeout: 1, attempts: 5 });
    expect(parseResolvConf("")).toEqual({ nameservers: [], search: [], ndots: 1, timeout: 5, attempts: 2 });
  });

  it("finds /etc/hosts names and aliases case-insensitively, and orders search domains by ndots", () => {
    expect(hostsAddresses("10.0.0.1 Box alias\n# 10.0.0.9 box\n::1 box\n", "BOX.")).toEqual(["10.0.0.1", "::1"]);
    const config = parseResolvConf("search a.test b.test\n");
    expect(candidates("db", config)).toEqual(["db.a.test", "db.b.test", "db"]);
    expect(candidates("api.example.com", config)).toEqual(["api.example.com", "api.example.com.a.test", "api.example.com.b.test"]);
    expect(candidates("example.com.", config)).toEqual(["example.com"]);
  });

  it("encodes a query with OPT and decodes CNAME chains, refusing stray answers", () => {
    const query = encodeQuery(0x1234, "www.example.com", DNS_TYPE.A);
    const answer = dnsAnswerer({ "www.example.com": ["93.184.215.14"] })(query);
    if (answer === null) throw new Error("no answer");
    expect(decodeAnswer(answer, 0x1234, "www.example.com", DNS_TYPE.A)).toEqual({ kind: "addresses", addresses: ["93.184.215.14"] });
    expect(decodeAnswer(answer, 0x9999, "www.example.com", DNS_TYPE.A)).toBeNull();
    expect(decodeAnswer(answer, 0x1234, "other.example", DNS_TYPE.A)).toBeNull();
  });

  it("answers from /etc/hosts first, then the VM's nameserver, with search domains", async () => {
    const net = network();
    net.listenDatagram("10.0.2.3", 53, dnsAnswerer({ "db.corp.example": ["10.1.1.1"], "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"] }));
    expect(await resolve(net.sockets(), "internet", "vm.local")).toEqual(["10.0.2.15"]);
    expect(await resolve(net.sockets(), "internet", "db")).toEqual(["10.1.1.1"]);
    expect(await resolve(net.sockets(), "internet", "example.com")).toEqual(["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
    expect(resolveSync(net.syncSockets(), "internet", "example.com")).toEqual(["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
    await expect(resolve(net.sockets(), "internet", "missing.test")).rejects.toMatchObject({ code: "ENOTFOUND", hostname: "missing.test" });
    expect(await resolve(net.sockets(), "internet", "192.0.2.1")).toEqual(["192.0.2.1"]);
  });

  it("a VM-only module resolves from /etc/hosts alone and never sends a datagram", async () => {
    const net = network("vm");
    net.listenDatagram("10.0.2.3", 53, dnsAnswerer({ "example.com": ["93.184.215.14"] }));
    expect(await resolve(net.sockets(), "vm", "vm")).toEqual(["10.0.2.15"]);
    await expect(resolve(net.sockets(), "vm", "example.com")).rejects.toMatchObject({ code: "ENOTFOUND", reason: "vm-hosts-only" });
    expect(net.attempts).toEqual([]);
  });

  it("local-only is EPERM vm-local-only; a silent server times out per resolv.conf as EAI_AGAIN", async () => {
    const offline = network();
    offline.state = "local-only";
    await expect(resolve(offline.sockets(), "internet", "example.com")).rejects.toMatchObject({ code: "EPERM", reason: "vm-local-only" });
    let refused: unknown;
    try { resolveSync(offline.syncSockets(), "internet", "example.com"); } catch (error: unknown) { refused = error; }
    expect(refused).toMatchObject({ code: "EPERM", reason: "vm-local-only" });
    const silent = network("internet", "nameserver 10.0.2.3\noptions timeout:1 attempts:1\n");
    silent.listenDatagram("10.0.2.3", 53, () => null);
    vi.useFakeTimers();
    const pending = resolve(silent.sockets(), "internet", "example.com");
    const outcome = expect(pending).rejects.toMatchObject({ code: "EAI_AGAIN" });
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it("refuses invalid names and honours the caller's abort", async () => {
    const net = network();
    net.listenDatagram("10.0.2.3", 53, () => null);
    await expect(resolve(net.sockets(), "internet", "bad name!")).rejects.toMatchObject({ code: "ENOTFOUND" });
    const controller = new AbortController(), pending = resolve(net.sockets(), "internet", "example.com", controller.signal);
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
