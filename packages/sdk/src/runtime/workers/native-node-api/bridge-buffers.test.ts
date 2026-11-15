import { expect, it } from "vitest";
import { NativeBridge } from "./bridge.js";
import { decodeNativeFrame, encodeNativeFrame, type NativeFrame } from "./codec.js";

const empty = new Uint8Array();

/** A native peer that answers each frame JavaScript writes with the frames `respond` returns. */
function peer(operationSet: number, respond: (frame: NativeFrame) => readonly NativeFrame[]) {
  const queue: Uint8Array[] = [], written: NativeFrame[] = []; let offset = 0;
  const bridge = new NativeBridge({ call: () => { throw new Error("No asynchronous request expected"); } }, {
    read(_fd, count) {
      const bytes = queue[0]; if (bytes === undefined) throw new Error("Unexpected native read");
      const result = bytes.slice(offset, offset + count); offset += result.length;
      if (offset === bytes.length) { queue.shift(); offset = 0; }
      return result;
    },
    writeAll(_fd, bytes) {
      const frame = decodeNativeFrame(bytes.subarray(4)); written.push(frame);
      for (const next of respond(frame)) queue.push(encodeNativeFrame(next));
    },
  }, 3, 4, { operationSet, changed: () => undefined, failed: () => undefined, uncaught: error => { throw error; } });
  return { bridge, written };
}
/** Loads an add-on whose module is a two-byte buffer native code made, then serves `later` for every further invocation. */
function loaded(operationSet: number, later: (frame: NativeFrame) => readonly NativeFrame[]) {
  const result = peer(operationSet, frame => {
    if (frame.kind === 1 && frame.operation === "load") return [{ kind: 3, sequence: 1, scope: 1n, environment: 0n, operation: "napi_create_buffer_copy", status: 0, args: [], bytes: new Uint8Array([7, 8]) }];
    if (frame.kind === 4 && frame.operation === "napi_create_buffer_copy") return [{ kind: 2, sequence: 1, scope: 1n, environment: 0n, operation: "load", status: 0, args: [frame.args[0] ?? 0n], bytes: empty }];
    return later(frame);
  });
  const value = result.bridge.load("/fixture.node");
  if (!(value instanceof Uint8Array)) throw new Error("Missing native buffer");
  result.written.length = 0;
  return { ...result, value };
}
const done = (frame: NativeFrame): NativeFrame => ({ kind: 2, sequence: frame.sequence, scope: frame.scope, environment: 0n, operation: frame.operation, status: 0, args: [0n], bytes: empty });

it("operation set 2 sends a changed buffer before the invocation that hands control to native code", () => {
  const { bridge, written, value } = loaded(2, frame => frame.kind === 1 ? [done(frame)] : []);
  bridge.raiseSignal(15);
  expect(written.map(frame => frame.kind)).toEqual([1]);
  value[0] = 42; written.length = 0; bridge.raiseSignal(15);
  expect(written.map(frame => [frame.kind, frame.operation])).toEqual([[9, "buffer-push"], [1, "raise-signal"]]);
  expect(written[0]).toMatchObject({ sequence: 1, scope: 0x1_0000_0001n, args: [1n], status: 0 });
  expect([...(written[0]?.bytes ?? [])]).toEqual([42, 8]);
  written.length = 0; bridge.raiseSignal(15);
  expect(written.map(frame => frame.kind)).toEqual([1]);
});

it("operation set 2 sends a buffer changed inside a callback before the Node-API reply", () => {
  let asked = false;
  const { bridge, written, value } = loaded(2, frame => {
    if (frame.kind === 1) return [{ kind: 3, sequence: 2, scope: frame.scope, environment: 0n, operation: "buffer-update", status: 0, args: [1n], bytes: new Uint8Array([1, 2]) }];
    // napi_get_global's handle stands in for a call into JavaScript: reading a property of it may run a getter, which here changes the buffer.
    if (frame.kind === 4 && frame.operation === "buffer-update") return [{ kind: 3, sequence: 3, scope: frame.scope, environment: 0n, operation: "napi_get_global", status: 0, args: [], bytes: empty }];
    if (frame.kind === 4 && !asked) { asked = true; value[1] = 99; return [{ kind: 3, sequence: 4, scope: frame.scope, environment: 0n, operation: "napi_get_named_property", status: 0, args: [frame.args[0] ?? 0n], bytes: new TextEncoder().encode("missing") }]; }
    if (frame.kind === 4) return [{ kind: 2, sequence: 2, scope: frame.scope, environment: 0n, operation: "raise-signal", status: 0, args: [0n], bytes: empty }];
    return [];
  });
  bridge.raiseSignal(15);
  expect(written.map(frame => [frame.kind, frame.operation])).toEqual([[1, "raise-signal"], [4, "buffer-update"], [4, "napi_get_global"], [9, "buffer-push"], [4, "napi_get_named_property"]]);
  expect([...(written[3]?.bytes ?? [])]).toEqual([1, 99]); expect([...value]).toEqual([1, 99]);
});

it("an earlier operation set sends no buffer frames", () => {
  const { bridge, written, value } = loaded(1, frame => frame.kind === 1 ? [done(frame)] : []);
  value[0] = 42; bridge.raiseSignal(15);
  expect(written.map(frame => frame.kind)).toEqual([1]);
});

it("operation set 2 skips the comparison after requests that run no JavaScript, and compares again once JavaScript ran", () => {
  let step = 0;
  const { bridge, written, value } = loaded(2, frame => {
    if (frame.kind === 1) return [{ kind: 3, sequence: 2, scope: frame.scope, environment: 0n, operation: "napi_get_global", status: 0, args: [], bytes: empty }];
    if (frame.kind !== 4) return [];
    step++;
    // A buffer changed behind a request that runs no JavaScript is not looked for: only a getter, trap or callback could change one.
    if (step === 1) { value[0] = 50; return [{ kind: 3, sequence: 3, scope: frame.scope, environment: 0n, operation: "napi_typeof", status: 0, args: [frame.args[0] ?? 0n], bytes: empty }]; }
    // A property read may run a getter: its reply follows a comparison.
    if (step === 2) return [{ kind: 3, sequence: 4, scope: frame.scope, environment: 0n, operation: "napi_get_undefined", status: 0, args: [], bytes: empty }];
    if (step === 3) return [{ kind: 3, sequence: 5, scope: frame.scope, environment: 0n, operation: "napi_coerce_to_string", status: 0, args: [frame.args[0] ?? 0n], bytes: empty }];
    return [{ kind: 2, sequence: 2, scope: frame.scope, environment: 0n, operation: "raise-signal", status: 0, args: [0n], bytes: empty }];
  });
  bridge.raiseSignal(15);
  expect(written.map(frame => [frame.kind, frame.operation])).toEqual([[1, "raise-signal"], [4, "napi_get_global"], [4, "napi_typeof"], [4, "napi_get_undefined"], [9, "buffer-push"], [4, "napi_coerce_to_string"]]);
  // The invocation returned and JavaScript ran: the next invocation compares before it hands over.
  value[1] = 51; written.length = 0;
  expect(() => { bridge.raiseSignal(15); }).toThrow();
  expect(written.map(frame => [frame.kind, frame.operation]).slice(0, 2)).toEqual([[9, "buffer-push"], [1, "raise-signal"]]);
});
