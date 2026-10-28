import { expect, it } from "vitest";
import { Buffer } from "buffer";
import { Http2Bridge } from "./node-http2-bridge.js";
import type { PipedChildHandle } from "./node-children.js";
import { EventEmitter, Readable, Writable } from "./node-streams.js";
import { encodeNativeFrame } from "./native-frames.js";

function fixture() {
  const stdout = new Readable({ read() {} }), stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_bytes: unknown, _encoding, done) { done(); } });
  let kills = 0;
  const child: PipedChildHandle = Object.assign(new EventEmitter(), {
    pid: 1, exitCode: null, signalCode: null, killed: false, stdin, stdout, stderr,
    stdio: [stdin, stdout, stderr] as const,
    kill() { kills++; return true; }, ref() { return child; }, unref() { return child; },
  });
  const retired = Promise.withResolvers<Error | undefined>();
  const bridge = new Http2Bridge({ spawnService: () => child }, { role: "client", authority: "http://127.0.0.1:1", options: {} },
    { event() {}, data() {}, retired: error => retired.resolve(error) });
  const finish = (event: unknown) => {
    stderr.push(encodeNativeFrame(1, Buffer.from(JSON.stringify(event)))); stderr.push(null); stdout.push(null);
    child.emit("close", 0, null);
  };
  return { bridge, retired: retired.promise, finish, kills: () => kills };
}
it("drains the last control record when child close follows buffered EOF", async () => {
  const f = fixture(); f.finish({ kind: "done" });
  expect(await f.retired).toBeUndefined(); expect(f.kills()).toBe(0);
});
it("fences an unmatched completion and never retries its native service", async () => {
  const f = fixture(); f.finish({ kind: "reply", request: 9, error: null });
  expect(await f.retired).toMatchObject({ code: "PROTOCOL_ERROR" }); expect(f.kills()).toBe(1);
});
