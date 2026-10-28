import { describe, expect, it } from "vitest";
import { defineImage } from "./image.js";
import { decodePublicVMOptions, resolveProcessLimit } from "./vm-options.js";

it("keeps image preparation on-demand by default and accepts complete installation in both modes", () => {
  for (const mode of ["system", "userspace"] as const) {
    expect(decodePublicVMOptions({ mode }).imagePreparation).toBe("on-demand");
    expect(decodePublicVMOptions({ mode, imagePreparation: "before-ready" }).imagePreparation).toBe("before-ready");
    expect(() => decodePublicVMOptions({ mode, imagePreparation: "best-effort" })).toThrow();
  }
});
import { VMError } from "./runtime/errors.js";

describe("public VM options", () => {
  it("maps commandInterceptors onto automatic acceleration and custom interceptors", () => {
    expect(decodePublicVMOptions({ mode: "userspace" })).toHaveProperty("acceleration", "auto");
    expect(decodePublicVMOptions({ mode: "userspace", commandInterceptors: "auto" })).toHaveProperty("acceleration", "auto");
    expect(decodePublicVMOptions({ mode: "userspace", commandInterceptors: "off" })).toMatchObject({ acceleration: "off", interceptors: false });
    expect(decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame" } })).toHaveProperty("acceleration", "auto");
    expect(decodePublicVMOptions({ mode: "userspace", commandInterceptors: "off", runtime: { hosting: "frame" } })).toHaveProperty("acceleration", "off");
  });
  it("rejects unknown command interceptor settings, root with acceleration, and the retired option names", () => {
    for (const options of [
      { mode: "system", commandInterceptors: "auto" },
      { mode: "userspace", commandInterceptors: "fast" },
      { mode: "userspace", commandInterceptors: "auto", initialUser: "root" },
      { mode: "userspace", acceleration: "auto" },
      { mode: "userspace", acceleration: "off" },
      { mode: "userspace", interceptors: false },
    ]) expect(() => decodePublicVMOptions(options)).toThrow(VMError);
  });
  it("admits explicit root and durable root storage only in Userspace mode", () => {
    expect(decodePublicVMOptions({ mode: "userspace", commandInterceptors: "off", workspaceId: "example", initialUser: "root", rootPersistence: "persistent" }))
      .toMatchObject({ initialUser: "root", rootPersistence: "persistent" });
    const defaults = decodePublicVMOptions({ mode: "userspace" });
    expect(defaults).not.toHaveProperty("initialUser");
    expect(defaults).not.toHaveProperty("rootPersistence");
    for (const input of [
      { mode: "system", initialUser: "root" }, { mode: "system", rootPersistence: "persistent" },
      { mode: "userspace", initialUser: "admin" }, { mode: "userspace", rootPersistence: "disk" },
      { mode: "userspace", rootPersistence: "persistent" },
    ]) expect(() => decodePublicVMOptions(input)).toThrow(VMError);
  });
  it("keeps omitted workspace IDs ephemeral and explicit IDs durable", () => {
    const a = decodePublicVMOptions({ mode: "userspace" });
    const b = decodePublicVMOptions({ mode: "userspace" });
    expect(a.ephemeral).toBe(true);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.workspaceId.length).toBeLessThanOrEqual(128);
    if (a.mode !== "userspace") throw new Error("expected Userspace options");
    expect(a.limits.maxProcesses).toBe(32);
    expect(decodePublicVMOptions({ mode: "system", workspaceId: "example-1" })).toMatchObject({ ephemeral: false, workspaceId: "example-1", vcpus: 1, network: { mode: "local" } });
  });
  it.each([{}, { mode: "kernel" }, { mode: "system", limits: {} }, { mode: "userspace", vcpus: 1 }, { mode: "system", workspaceId: "" }, { mode: "system", workspaceId: "../escape" }, { mode: "system", workspaceId: "x".repeat(129) }, { mode: "userspace", limits: { maxProcesses: 65 } }, { mode: "system", memoryMiB: 0 }, { mode: "system", network: { mode: "relay" } }, { mode: "system", preview: { origin: "https://preview.test", isolation: "shared" } }, { mode: "system", image: { mode: "system" } }])("rejects invalid cross-field options before accessing browser state: %j", input => {
    try { decodePublicVMOptions(input); throw new Error("invalid options were admitted"); }
    catch (error) { expect(error).toBeInstanceOf(VMError); if (!(error instanceof VMError)) throw error; expect(error.code).toBe("INVALID_ARGUMENT"); }
  });
  it("selects the runtime: self-hosted by default and for the older { baseUrl } shape, the hosted frame on request", () => {
    expect(decodePublicVMOptions({ mode: "userspace" }).runtime).toEqual({ hosting: "self-hosted", baseUrl: "/oxidevm/runtime/" });
    expect(decodePublicVMOptions({ mode: "userspace", runtime: { baseUrl: "/engine" } }).runtime).toEqual({ hosting: "self-hosted", baseUrl: "/engine/" });
    expect(decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "self-hosted", baseUrl: "https://cdn.example.test/engine/" } }).runtime).toEqual({ hosting: "self-hosted", baseUrl: "https://cdn.example.test/engine/" });
    expect(decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame" } })).toMatchObject({ runtime: { hosting: "frame", origin: "https://run.oxidevm.dev" }, preview: { origin: "https://oxvm.dev", isolation: "per-session" } });
    expect(decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame", origin: "https://run.example.test" } }).preview).toBeUndefined();
    expect(decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame" }, preview: { origin: "https://previews.example.test", isolation: "per-session" } }).preview).toEqual({ origin: "https://previews.example.test", isolation: "per-session" });
    expect(decodePublicVMOptions({ mode: "system", runtime: { hosting: "frame", origin: new URL("https://run.example.test") } }).runtime).toEqual({ hosting: "frame", origin: "https://run.example.test" });
  });
  it.each([
    { hosting: "frame", origin: "https://run.example.test/v/1/" },
    { hosting: "frame", origin: "/relative" },
    { hosting: "frame", origin: "http://run.example.test" },
    { hosting: "frame", baseUrl: "/engine/" },
    { hosting: "self-hosted" },
    { mode: "cdn", baseUrl: "/engine/" },
    { baseUrl: "/engine/", origin: "https://run.example.test" },
  ])("rejects an invalid runtime selection: %j", runtime => {
    try { decodePublicVMOptions({ mode: "userspace", runtime }); throw new Error("invalid runtime was admitted"); }
    catch (error) { expect(error).toBeInstanceOf(VMError); if (!(error instanceof VMError)) throw error; expect(error.code).toBe("INVALID_ARGUMENT"); }
  });
  it("requires the opaque reference to agree with the selected mode", async () => {
    const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey))));
    const image = defineImage({ mode: "userspace", manifestUrl: "/image/manifest.json", manifestSHA256: "a".repeat(64), trust: { algorithm: "Ed25519", keyId: "test", publicKey } });
    expect(decodePublicVMOptions({ mode: "userspace", image }).image).toBe(image);
    for (const options of [{ mode: "system", image }, { mode: "userspace", image: { ...image } }]) {
      try { decodePublicVMOptions(options); throw new Error("invalid image was admitted"); }
      catch (error) { expect(error).toBeInstanceOf(VMError); if (!(error instanceof VMError)) throw error; expect(error.code).toBe("INVALID_ARGUMENT"); }
    }
  });
  it("decodes relay protocol 2 connections into owned copies through the network owner's rules", () => {
    const headers = { authorization: "Bearer browser-safe" };
    const server = { kind: "server", url: new URL("https://app.example.test/oxidevm-relay/"), sessionUrl: "https://app.example.test/api/oxidevm/relay-session", headers };
    const personal = decodePublicVMOptions({ mode: "userspace", network: { mode: "relay", connection: { kind: "personal", workspaceName: "My project" } } });
    const operator = decodePublicVMOptions({ mode: "system", network: { mode: "relay", connection: server } });
    expect(personal.network).toEqual({ mode: "relay", connection: { kind: "personal", workspaceName: "My project" } });
    expect(operator.network).toEqual({ mode: "relay", connection: { kind: "server", url: "https://app.example.test/oxidevm-relay/", sessionUrl: "https://app.example.test/api/oxidevm/relay-session", headers } });
    if (operator.network.mode !== "relay" || operator.network.connection.kind !== "server") throw new Error("expected a server relay");
    expect(operator.network.connection.headers).not.toBe(headers);
    expect(decodePublicVMOptions({ mode: "userspace", network: { mode: "local" } }).network).toEqual({ mode: "local" });
    // The relay owner resolves a relative session route against the page when it connects.
    const relative = { kind: "server", url: "https://relay.example.test/", sessionUrl: "/api/oxidevm/relay-session" };
    expect(decodePublicVMOptions({ mode: "userspace", network: { mode: "relay", connection: relative } }).network).toEqual({ mode: "relay", connection: relative });
    expect(decodePublicVMOptions({ mode: "userspace", network: { mode: "relay", connection: { ...relative, sessionUrl: new URL("https://app.example.test/session") } } }).network)
      .toEqual({ mode: "relay", connection: { ...relative, sessionUrl: "https://app.example.test/session" } });
  });
  it.each([
    { mode: "local", relayUrl: "https://relay.example.com/" },
    { mode: "local", connection: { kind: "personal" } },
    { mode: "relay" },
    { mode: "relay", relayUrl: "wss://relay.example.com/" },
    { mode: "relay", connection: { kind: "personal" }, relayUrl: "https://relay.example.com/" },
    { mode: "relay", connection: "personal" },
    { mode: "relay", connection: { kind: "automatic" } },
    { mode: "relay", connection: { kind: "server" } },
    { mode: "relay", connection: { kind: "personal", url: "https://relay.example.com/" } },
    { mode: "relay", connection: { kind: "personal", headers: { authorization: "secret" } } },
    { mode: "relay", connection: { kind: "personal", workspaceName: "" } },
    { mode: "relay", connection: { kind: "server", url: "http://relay.example.com/" } },
    { mode: "relay", connection: { kind: "server", url: "relay.example.com" } },
    { mode: "relay", connection: { kind: "server", url: "https://user:secret@relay.example.com/" } },
    { mode: "relay", connection: { kind: "server", url: "https://relay.example.com/", sessionUrl: "https://[session" } },
    { mode: "relay", connection: { kind: "server", url: "https://relay.example.com/", headers: { cookie: "session=secret" } } },
  ])("rejects network option %j as an invalid argument", network => {
    for (const mode of ["system", "userspace"]) {
      try { decodePublicVMOptions({ mode, network }); throw new Error("invalid network options were admitted"); }
      catch (error) { expect(error).toBeInstanceOf(VMError); if (!(error instanceof VMError)) throw error; expect(error.code).toBe("INVALID_ARGUMENT"); }
    }
  });
  it("uses the signed process recommendation by default and admits an explicit bounded override", () => {
    const defaults = decodePublicVMOptions({ mode: "userspace" });
    const override = decodePublicVMOptions({ mode: "userspace", limits: { maxProcesses: 16 } });
    if (defaults.mode !== "userspace" || override.mode !== "userspace") throw new Error("expected Userspace options");
    expect(resolveProcessLimit(defaults)).toBe(32);
    expect(resolveProcessLimit(defaults, 8)).toBe(8);
    expect(resolveProcessLimit(override, 8)).toBe(16);
  });
});

it("validates restore points identically for Userspace and System, and rejects the retired resume key", () => {
  for (const mode of ["userspace", "system"] as const) {
    for (const restorePoint of ["none", "latest", "pre-resume", "fresh-image", "update-image"]) {
      expect(decodePublicVMOptions({ mode, restorePoint })).toMatchObject({ mode, resume: restorePoint });
    }
    const point = { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-10-13T00:00:00.000Z" };
    expect(decodePublicVMOptions({ mode, restorePoint: point }).resume).toEqual(point);
    expect(() => decodePublicVMOptions({ mode, restorePoint: "guess" })).toThrow(VMError);
    expect(() => decodePublicVMOptions({ mode, restorePoint: { ...point, extra: true } })).toThrow(VMError);
    expect(() => decodePublicVMOptions({ mode, resume: "none" })).toThrow(VMError);
  }
});

it("accepts bounded shippedSnapshot IDs in either mode, rejects malformed IDs and the retired shipped key",()=>{
  for(const mode of ["system","userspace"] as const) {
    expect(decodePublicVMOptions({mode,shippedSnapshot:"ready-v1"})).toMatchObject({shipped:"ready-v1"});
    for(const shippedSnapshot of ["", "../ready", "x".repeat(129), 1]) expect(()=>decodePublicVMOptions({mode,shippedSnapshot})).toThrow(VMError);
    expect(()=>decodePublicVMOptions({mode,shipped:"ready-v1"})).toThrow(VMError);
  }
});

it("admits one explicit self-hosted TypeScript command interceptor and rejects frame execution", () => {
  const worker = new URL("https://example.test/tsc.worker.js");
  expect(decodePublicVMOptions({ mode: "userspace", commandInterceptors: [{ command: "tsc", worker }] })).toMatchObject({ interceptors: [{ command: "tsc", worker: worker.href }] });
  expect(() => decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame" }, commandInterceptors: [{ command: "tsc", worker }] })).toThrow();
  expect(() => decodePublicVMOptions({ mode: "system", commandInterceptors: [{ command: "tsc", worker }] })).toThrow();
  expect(() => decodePublicVMOptions({ mode: "userspace", commandInterceptors: [{ command: "node", worker }] })).toThrow();
});
