import type { LinuxSocketAddress } from "../../js-process-types.js";
import type { ModuleReach } from "../reach.js";
import { decodeAnswer, DNS_PAYLOAD_BYTES, DNS_TYPE, DnsFormatError, encodeQuery, nameLabels, type AddressType, type DnsAnswer } from "./dns.js";
import { aborted, abortReason, NetError, netError } from "./errors.js";
import type { NetSockets, NetSyncSockets } from "./ports.js";
import { addressFamily, isAddressLiteral } from "./addresses.js";
import { deadline } from "./deadline.js";

/**
 * The module network's resolver (engine ADR 0029, N-1): the VM's own `/etc/hosts`, then, for a module with internet
 * reach, the nameservers of the VM's `/etc/resolv.conf`, asked over the module process's own datagram socket, so the
 * module gets the answers `curl` in the VM gets. A VM-only module resolves from `/etc/hosts` alone.
 */
export interface ResolverConfig {
  readonly nameservers: readonly string[];
  readonly search: readonly string[];
  readonly ndots: number;
  /** Seconds per query, as resolv.conf's `timeout`. */
  readonly timeout: number;
  readonly attempts: number;
}

const RESOLV_CONF = "/etc/resolv.conf", HOSTS = "/etc/hosts", MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULTS: ResolverConfig = { nameservers: [], search: [], ndots: 1, timeout: 5, attempts: 2 };
const POLL_MS = 5;

const bounded = (value: string | undefined, low: number, high: number, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? Math.min(high, Math.max(low, parsed)) : fallback;
};

/** resolv.conf as glibc reads it: up to three nameservers, the last `search` or `domain` line, and its options. */
export function parseResolvConf(text: string): ResolverConfig {
  const nameservers: string[] = [];
  let search: readonly string[] = [], ndots = DEFAULTS.ndots, timeout = DEFAULTS.timeout, attempts = DEFAULTS.attempts;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[#;].*$/u, "").trim(), [keyword, ...rest] = line.split(/\s+/u);
    if (keyword === "nameserver" && rest[0] !== undefined && isAddressLiteral(rest[0]) && nameservers.length < 3) nameservers.push(rest[0]);
    else if (keyword === "search") search = rest.filter(domain => domain.length > 0).slice(0, 6);
    else if (keyword === "domain" && rest[0] !== undefined) search = [rest[0]];
    else if (keyword === "options") for (const option of rest) {
      const [name, value] = option.split(":");
      if (name === "ndots") ndots = bounded(value, 0, 15, ndots);
      if (name === "timeout") timeout = bounded(value, 1, 30, timeout);
      if (name === "attempts") attempts = bounded(value, 1, 5, attempts);
    }
  }
  return { nameservers, search, ndots, timeout, attempts };
}

/** The addresses /etc/hosts gives `name`, in file order. */
export function hostsAddresses(text: string, name: string): readonly string[] {
  const wanted = name.toLowerCase().replace(/\.$/u, ""), found: string[] = [];
  for (const raw of text.split("\n")) {
    const [address, ...names] = raw.replace(/#.*$/u, "").trim().split(/\s+/u);
    if (address === undefined || !isAddressLiteral(address) || !names.some(entry => entry.toLowerCase() === wanted)) continue;
    if (!found.includes(address)) found.push(address);
  }
  return found;
}

/** The full names to ask for, in order: search domains first when the name has fewer dots than `ndots`. */
export function candidates(name: string, config: ResolverConfig): readonly string[] {
  if (name.endsWith(".")) return [name.slice(0, -1)];
  const searched = config.search.map(domain => `${name}.${domain.replace(/\.$/u, "")}`);
  const dots = name.split(".").length - 1;
  return dots >= config.ndots ? [name, ...searched] : [...searched, name];
}

const text = (bytes: Uint8Array | null): string => bytes === null ? "" : new TextDecoder().decode(bytes);
const LOOPBACK = ["127.0.0.1", "::1"] as const;

function randomId(): number { return crypto.getRandomValues(new Uint16Array(1))[0] ?? 0; }

function server(address: string): LinuxSocketAddress { return { family: addressFamily(address), address, port: 53 }; }

function notFound(name: string, reach: ModuleReach): NetError {
  return reach === "vm"
    ? new NetError("ENOTFOUND", `getaddrinfo ENOTFOUND ${name}: a VM-only module resolves names from /etc/hosts`, { reason: "vm-hosts-only", syscall: "getaddrinfo", hostname: name })
    : new NetError("ENOTFOUND", `getaddrinfo ENOTFOUND ${name}`, { syscall: "getaddrinfo", hostname: name });
}

/** What one round of A and AAAA questions to one server concluded for one full name. */
type Round = { readonly kind: "done"; readonly addresses: readonly string[] } | { readonly kind: "next-name" } | { readonly kind: "next-server" };

function conclude(answers: readonly (DnsAnswer | null)[]): Round {
  const addresses = answers.flatMap(answer => answer?.kind === "addresses" ? answer.addresses : []);
  if (addresses.length > 0) return { kind: "done", addresses };
  if (answers.every(answer => answer?.kind === "no-name" || answer?.kind === "no-data")) return { kind: "next-name" };
  return { kind: "next-server" };
}

interface Question { readonly id: number; readonly type: AddressType; readonly bytes: Uint8Array }
function questions(full: string): readonly Question[] {
  return [DNS_TYPE.A, DNS_TYPE.AAAA].map(type => { const id = randomId(); return { id, type, bytes: encodeQuery(id, full, type) }; });
}

function match(datagram: Uint8Array, asked: readonly Question[], full: string, answers: (DnsAnswer | null)[]): void {
  asked.forEach((question, index) => {
    if (answers[index] !== null) return;
    try { answers[index] = decodeAnswer(datagram, question.id, full, question.type); } catch (error: unknown) { if (!(error instanceof DnsFormatError)) throw error; }
  });
}

function validName(name: string): void {
  try { nameLabels(name); } catch { throw new NetError("ENOTFOUND", `getaddrinfo ENOTFOUND ${name}`, { syscall: "getaddrinfo", hostname: name }); }
}

/** Resolves `name` to its addresses, asynchronously. */
export async function resolve(sockets: NetSockets, reach: ModuleReach, name: string, signal?: AbortSignal): Promise<readonly string[]> {
  if (isAddressLiteral(name)) return [name];
  validName(name);
  const hosts = hostsAddresses(text(await sockets.readFile(HOSTS, MAX_CONFIG_BYTES)), name);
  if (hosts.length > 0) return hosts;
  if (name.toLowerCase() === "localhost") return LOOPBACK;
  if (reach !== "internet") throw notFound(name, reach);
  const config = parseResolvConf(text(await sockets.readFile(RESOLV_CONF, MAX_CONFIG_BYTES)));
  if (config.nameservers.length === 0) throw new NetError("EAI_AGAIN", `getaddrinfo EAI_AGAIN ${name}: /etc/resolv.conf names no nameserver`, { syscall: "getaddrinfo", hostname: name });
  for (const full of candidates(name, config)) {
    const round = await askServers(sockets, config, full, signal);
    if (round.kind === "done") return round.addresses;
    if (round.kind === "next-server") throw new NetError("EAI_AGAIN", `getaddrinfo EAI_AGAIN ${name}`, { syscall: "getaddrinfo", hostname: name });
  }
  throw notFound(name, reach);
}

async function askServers(sockets: NetSockets, config: ResolverConfig, full: string, signal: AbortSignal | undefined): Promise<Round> {
  for (let attempt = 0; attempt < config.attempts; attempt++) {
    for (const address of config.nameservers) {
      const round = await askOne(sockets, server(address), full, config.timeout * 1000, signal);
      if (round.kind !== "next-server") return round;
    }
  }
  return { kind: "next-server" };
}

async function askOne(sockets: NetSockets, destination: LinuxSocketAddress, full: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<Round> {
  if (signal !== undefined && aborted(signal)) throw abortReason(signal);
  const fd = await sockets.datagram(destination.family === "ipv6" ? "ipv6" : "ipv4").catch((error: unknown) => { throw netError(error, "getaddrinfo", full); });
  const timer = deadline(timeoutMs, signal, "The DNS query"), wait = timer.signal;
  try {
    const asked = questions(full), answers: (DnsAnswer | null)[] = asked.map(() => null);
    try { for (const question of asked) await sockets.sendTo(fd, question.bytes, destination); }
    catch (error: unknown) { throw netError(error, "getaddrinfo", full); }
    while (answers.some(answer => answer === null)) {
      let datagram;
      try { datagram = await sockets.receiveFrom(fd, DNS_PAYLOAD_BYTES, wait); }
      catch (error: unknown) {
        if (signal !== undefined && aborted(signal)) throw abortReason(signal);
        if (timer.expired()) return conclude(answers);
        throw netError(error, "getaddrinfo", full);
      }
      match(datagram.bytes, asked, full, answers);
    }
    return conclude(answers);
  } finally { timer.clear(); await sockets.close(fd).catch(() => undefined); }
}

/** Resolves `name` without leaving this worker's turn: for interpreters that call `getaddrinfo` synchronously. */
export function resolveSync(sockets: NetSyncSockets, reach: ModuleReach, name: string): readonly string[] {
  if (isAddressLiteral(name)) return [name];
  validName(name);
  const hosts = hostsAddresses(text(sockets.readFile(HOSTS, MAX_CONFIG_BYTES)), name);
  if (hosts.length > 0) return hosts;
  if (name.toLowerCase() === "localhost") return LOOPBACK;
  if (reach !== "internet") throw notFound(name, reach);
  const config = parseResolvConf(text(sockets.readFile(RESOLV_CONF, MAX_CONFIG_BYTES)));
  if (config.nameservers.length === 0) throw new NetError("EAI_AGAIN", `getaddrinfo EAI_AGAIN ${name}: /etc/resolv.conf names no nameserver`, { syscall: "getaddrinfo", hostname: name });
  for (const full of candidates(name, config)) {
    let round: Round = { kind: "next-server" };
    for (let attempt = 0; attempt < config.attempts && round.kind === "next-server"; attempt++) {
      for (const address of config.nameservers) {
        round = askOneSync(sockets, server(address), full, config.timeout * 1000);
        if (round.kind !== "next-server") break;
      }
    }
    if (round.kind === "done") return round.addresses;
    if (round.kind === "next-server") throw new NetError("EAI_AGAIN", `getaddrinfo EAI_AGAIN ${name}`, { syscall: "getaddrinfo", hostname: name });
  }
  throw notFound(name, reach);
}

function askOneSync(sockets: NetSyncSockets, destination: LinuxSocketAddress, full: string, timeoutMs: number): Round {
  let fd: number;
  try { fd = sockets.datagram(destination.family === "ipv6" ? "ipv6" : "ipv4"); } catch (error: unknown) { throw netError(error, "getaddrinfo", full); }
  try {
    const asked = questions(full), answers: (DnsAnswer | null)[] = asked.map(() => null);
    try { for (const question of asked) sockets.sendTo(fd, question.bytes, destination); } catch (error: unknown) { throw netError(error, "getaddrinfo", full); }
    for (let waited = 0; answers.some(answer => answer === null); ) {
      let datagram;
      try { datagram = sockets.receiveNow(fd, DNS_PAYLOAD_BYTES); } catch (error: unknown) { throw netError(error, "getaddrinfo", full); }
      if (datagram !== null) { match(datagram.bytes, asked, full, answers); continue; }
      if (waited >= timeoutMs) break;
      sockets.sleep(POLL_MS); waited += POLL_MS;
    }
    return conclude(answers);
  } finally { try { sockets.close(fd); } catch { /* already closed */ } }
}
