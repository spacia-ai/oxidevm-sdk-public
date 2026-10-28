import { afterEach, describe, expect, it, vi } from "vitest";
import { VMError } from "../runtime/errors.js";
import { eraseOverPort } from "./client/erase.js";
import { serveFrame } from "./host/server.js";
import { closeChannels, fakeVM, rejection } from "./frame-vm.test-support.js";
import { FRAME_PROTOCOL_VERSION } from "./protocol/handshake.js";
import { decodeFrameMessage } from "./protocol/requests.js";

afterEach(closeChannels);

function serve(erase: (signal: AbortSignal) => Promise<void>) {
  const channel = new MessageChannel();
  const disposed = vi.fn();
  const create = vi.fn(() => Promise.reject(new VMError("PROTOCOL_ERROR", "not created")));
  serveFrame(channel.port2, { embedderOrigin: "https://page.example", eraseLocalData: erase, create, onDisposed: disposed });
  return { port: channel.port1, disposed, create, close: () => { channel.port1.close(); channel.port2.close(); } };
}

describe("runtime frame local data erasure (protocol 3)", () => {
  it("decodes only an argument-free, versioned erase request", () => {
    expect(decodeFrameMessage({ v: FRAME_PROTOCOL_VERSION, id: 1, type: "erase-local-data" })).toEqual({ type: "erase-local-data", id: 1 });
    expect(() => decodeFrameMessage({ v: FRAME_PROTOCOL_VERSION, id: 1, type: "erase-local-data", workspaceId: "only-this" })).toThrow();
    expect(() => decodeFrameMessage({ v: 2, id: 1, type: "erase-local-data" })).toThrow();
  });

  it("erases the frame origin's data for a page that created no VM there", async () => {
    const erase = vi.fn<(signal: AbortSignal) => Promise<void>>(() => Promise.resolve());
    const frame = serve(erase);
    try {
      await eraseOverPort(frame.port);
      expect(erase).toHaveBeenCalledOnce();
      expect(frame.create).not.toHaveBeenCalled();
      expect(frame.disposed).toHaveBeenCalledOnce();
    } finally { frame.close(); }
  });

  it("returns the frame's erasure failure with its code", async () => {
    const frame = serve(() => Promise.reject(new VMError("STORAGE_ERROR", "Close other OxideVM tabs, then retry cleanup", { reason: "local-data-in-use" })));
    try {
      expect(await rejection(eraseOverPort(frame.port))).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "local-data-in-use" } });
    } finally { frame.close(); }
  });

  it("disposes the VM the frame created before erasing, and serves nothing after", async () => {
    const { vm } = fakeVM();
    const order: string[] = [];
    vm.dispose.mockImplementation(() => { order.push("dispose"); return Promise.resolve(); });
    const channel = new MessageChannel();
    serveFrame(channel.port2, { embedderOrigin: "https://page.example", eraseLocalData: () => { order.push("erase"); return Promise.resolve(); }, create: () => Promise.resolve(vm) });
    const replies: unknown[] = [];
    const reply = () => new Promise<void>(resolve => { channel.port1.addEventListener("message", event => { replies.push(event.data); resolve(); }, { once: true }); });
    channel.port1.start();
    const created = reply();
    channel.port1.postMessage({ v: FRAME_PROTOCOL_VERSION, id: 1, type: "create", options: {} });
    await created;
    const erased = reply();
    channel.port1.postMessage({ v: FRAME_PROTOCOL_VERSION, id: 2, type: "erase-local-data" });
    await erased;
    const refused = reply();
    channel.port1.postMessage({ v: FRAME_PROTOCOL_VERSION, id: 3, type: "listeningPorts" });
    await refused;
    expect(order).toEqual(["dispose", "erase"]);
    expect(replies.slice(1)).toEqual([
      { v: FRAME_PROTOCOL_VERSION, type: "result", id: 2, ok: true, value: undefined },
      expect.objectContaining({ id: 3, ok: false }),
    ]);
    channel.port1.close(); channel.port2.close();
  });
});
