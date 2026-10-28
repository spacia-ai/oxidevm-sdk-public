import { expect, it } from "vitest";
import { LinuxError, type LinuxOperation } from "../../js-process/codec.js";
import { createNativeFileService, nativeModulePathInfo } from "./files.js";
import { encodeAddress } from "../../js-process/sockets.js";

it("cancels a pending connect through Rust and closes its descriptor without the aborted signal", async () => {
  const abort = new AbortController(), submitted: { number: number; signal: AbortSignal | undefined }[] = [];
  const service = createNativeFileService({
    sync() { throw new Error("Unexpected synchronous request"); },
    call(operation, signal) {
      submitted.push({ number: operation.number, signal });
      if (operation.number === 41) return Promise.resolve(operation.decode({ value: 8n, bytes: new Uint8Array() }));
      if (operation.number === 42) return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { reject(new LinuxError(125)); }, { once: true });
        abort.abort();
      });
      if (operation.number === 3) {
        expect(signal).toBeUndefined();
        return Promise.resolve(operation.decode({ value: 0n, bytes: new Uint8Array() }));
      }
      throw new Error(`Unexpected operation ${operation.number}`);
    },
  });
  const result = await service.call({ kind: "socket-connect-local", address: { address: "::1", port: 8080 } }, abort.signal);
  expect(result).toMatchObject({ kind: "error", errno: 125, code: "ECANCELED" });
  expect(submitted.map(request => request.number)).toEqual([41, 42, 3]);
  expect(submitted.slice(0, 2).every(request => request.signal === abort.signal)).toBe(true);
});

it.each([[2, "ENOENT"], [20, "ENOTDIR"], [13, "EACCES"]])("maps combined module metadata errno %s into the existing Node error contract", (errno, code) => {
  const client = { sync() { throw new LinuxError(errno); } };
  let failure: unknown;
  try { nativeModulePathInfo(client, "./missing/package.json"); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code, errno: -errno, syscall: "stat", path: "./missing/package.json" });
  const failed = new Error("transport retired");
  expect(() => nativeModulePathInfo({ sync() { throw failed; } }, "path")).toThrow(failed);
});

it("retains EPROTONOSUPPORT as a Linux errno in both socket option call styles", async () => {
  const service = createNativeFileService({ sync() { throw new LinuxError(93); }, call() { return Promise.reject(new LinuxError(93)); } });
  const request = { kind: "socket-nodelay", fd: 7, enabled: true } as const;
  const expected = { kind: "error", errno: 93, code: "EPROTONOSUPPORT", syscall: "socket-nodelay", path: null, destination: null };
  expect(service.callSync(request)).toEqual(expected);
  expect(await service.call(request)).toEqual(expected);
});

it("shares positioned I/O framing between async and sync calls and retains Linux errors", async () => {
  const submitted: LinuxOperation<unknown>[] = [];
  const service = createNativeFileService({
    sync(operation) { submitted.push(operation); return operation.decode({ value: 3n, bytes: Uint8Array.of(65, 66, 67) }); },
    call(operation) { submitted.push(operation); if (operation.number === 90) return Promise.reject(new LinuxError(13)); return Promise.resolve(operation.decode({ value: 3n, bytes: Uint8Array.of(65, 66, 67) })); },
  });
  const request = { kind: "read", fd: 8, length: 8, offset: 17n } as const;
  expect(service.callSync(request)).toEqual({ kind: "data", bytes: Uint8Array.of(65, 66, 67) });
  expect(await service.call(request)).toEqual({ kind: "data", bytes: Uint8Array.of(65, 66, 67) });
  expect(submitted.map(operation => operation.number)).toEqual([17, 17]);
  expect(submitted[0]?.payload).toEqual(submitted[1]?.payload);
  expect(await service.call({ kind: "chmod", path: "./private", mode: 0o600 })).toMatchObject({ kind: "error", errno: 13, code: "EACCES", path: "./private" });
});

it("keeps nontruncating write-create private to the native adapter", async () => {
  const flags: bigint[] = [];
  const service = createNativeFileService({
    sync(operation) { const view = new DataView(operation.payload.buffer, operation.payload.byteOffset, operation.payload.byteLength); flags.push(view.getBigUint64(operation.payload.length - 16, true)); return operation.decode({ value: 8n, bytes: new Uint8Array() }); },
    call(operation) { const view = new DataView(operation.payload.buffer, operation.payload.byteOffset, operation.payload.byteLength); flags.push(view.getBigUint64(operation.payload.length - 16, true)); return Promise.resolve(operation.decode({ value: 8n, bytes: new Uint8Array() })); },
  });
  const request = { kind: "open", path: "output", flags: 10, mode: 0o600 } as const;
  expect(service.callSync(request)).toEqual({ kind: "opened", fd: 8 });
  expect(await service.call(request)).toEqual({ kind: "opened", fd: 8 });
  expect(flags).toEqual([0o101n, 0o101n]);
});

it.each([false, true])("reports accepted peers and only treats ENOTCONN as a listener (async=%s)", async asynchronous => {
  let failure: Error | undefined;
  const local = { family: "ipv4", address: "127.0.0.1", port: 3000 } as const;
  const peer = { family: "ipv4", address: "127.0.0.1", port: 4567 } as const;
  function reply<Result>(operation: LinuxOperation<Result>): Result {
    if (operation.number === 52 && failure !== undefined) throw failure;
    expect([51, 52]).toContain(operation.number);
    const address = encodeAddress(operation.number === 51 ? local : peer), bytes = new Uint8Array(132);
    bytes.set(address); new DataView(bytes.buffer).setUint32(128, address.length, true);
    return operation.decode({ value: 0n, bytes });
  }
  const service = createNativeFileService({ sync: reply, call: operation => Promise.resolve().then(() => reply(operation)) });
  const query = () => asynchronous ? service.call({ kind: "socket-address", fd: 8 }) : Promise.resolve(service.callSync({ kind: "socket-address", fd: 8 }));
  const result = await query();
  expect(result).toEqual({ kind: "socket", fd: 8, local: { address: local.address, port: local.port }, peer: { address: peer.address, port: peer.port } });
  failure = new LinuxError(107);
  expect(await query()).toEqual({ ...result, peer: null });
  failure = new LinuxError(9);
  expect(await query()).toMatchObject({ kind: "error", errno: 9, code: "EBADF" });
  failure = new Error("transport lost");
  await expect(Promise.resolve().then(query)).rejects.toBe(failure);
});
