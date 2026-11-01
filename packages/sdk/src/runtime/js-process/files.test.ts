import { expect, it } from "vitest";
import { JS_MAILBOX_BYTES, descriptor, type LinuxOperation, type LinuxResult } from "./codec.js";
import { asyncFiles, syncFiles } from "./files.js";
import { LinuxClient } from "./transport.js";

/** Records each request and answers it from a table, so the facades are tested without an engine. */
class RecordingClient extends LinuxClient {
  readonly numbers: number[] = [];
  readonly payloads: Uint8Array[] = [];
  constructor(private readonly replies: ReadonlyMap<number, LinuxResult>) {
    const channel = new MessageChannel();
    super(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
    channel.port2.close();
  }
  private answer<T>(operation: LinuxOperation<T>): T {
    this.numbers.push(operation.number);
    this.payloads.push(operation.payload);
    return operation.decode(this.replies.get(operation.number) ?? { value: 0n, bytes: new Uint8Array() });
  }
  override sync<T>(operation: LinuxOperation<T>): T { return this.answer(operation); }
  override call<T>(operation: LinuxOperation<T>): Promise<T> {
    try { return Promise.resolve(this.answer(operation)); } catch (error: unknown) { return Promise.reject(error instanceof Error ? error : new Error("call failed")); }
  }
}

const readlinkReply = new Map([[89, { value: 5n, bytes: new TextEncoder().encode("a.txt") }]]);
const wrote = new Map([[1, { value: 3n, bytes: new Uint8Array() }], [44, { value: 3n, bytes: new Uint8Array() }]]);
const fd = descriptor(3);

it("exposes the Linux metadata operations through the synchronous facade", () => {
  const client = new RecordingClient(readlinkReply);
  try {
    const files = syncFiles(client);
    files.chmod("/a", 0o600); files.fchmod(fd, 0o600); files.truncate("/a", 4); files.ftruncate(fd, 4n); files.link("/a", "/b"); files.symlink("a", "/c");
    expect(files.readlink("/c")).toBe("a.txt");
    expect(client.numbers).toEqual([90, 91, 76, 77, 86, 88, 89]);
  } finally { client.dispose(); }
});

it("sets times and sends without SIGPIPE through the synchronous facade", () => {
  const client = new RecordingClient(wrote);
  try {
    const files = syncFiles(client), bytes = Uint8Array.of(1, 2, 3);
    files.utimes("/a", new Date(0), "now"); files.utimes("/a", "omit", "omit", { followLinks: false });
    expect(files.write(fd, bytes)).toBe(3); expect(files.write(fd, bytes, { noSignal: true })).toBe(3);
    files.writeAll(fd, bytes); files.writeAll(fd, bytes, { noSignal: true });
    expect(client.numbers).toEqual([280, 280, 1, 44, 1, 44]);
    // The last word of utimensat's payload is its flags: nothing when links are followed, AT_SYMLINK_NOFOLLOW when not.
    expect([client.payloads[0]?.at(-7), client.payloads[1]?.at(-7)]).toEqual([0, 1]);
  } finally { client.dispose(); }
});

it("sets times and sends without SIGPIPE through the asynchronous facade", async () => {
  const client = new RecordingClient(wrote);
  try {
    const files = asyncFiles(client), bytes = Uint8Array.of(1, 2, 3);
    await files.utimes("/a", new Date(0), "now"); await files.utimes("/a", "omit", "omit", { followLinks: false });
    await expect(files.write(fd, bytes)).resolves.toBe(3); await expect(files.write(fd, bytes, { noSignal: true })).resolves.toBe(3);
    await files.writeAll(fd, bytes); await files.writeAll(fd, bytes, { noSignal: true });
    expect(client.numbers).toEqual([280, 280, 1, 44, 1, 44]);
    expect([client.payloads[0]?.at(-7), client.payloads[1]?.at(-7)]).toEqual([0, 1]);
  } finally { client.dispose(); }
});

it("exposes the same operations through the asynchronous facade and propagates a Linux failure", async () => {
  const client = new RecordingClient(new Map([...readlinkReply, [86, { value: 17n, bytes: new Uint8Array() }]]));
  try {
    const files = asyncFiles(client);
    await files.chmod("/a", 0o600); await files.fchmod(fd, 0o600); await files.truncate("/a", 4); await files.ftruncate(fd, 4n); await files.symlink("a", "/c");
    await expect(files.readlink("/c")).resolves.toBe("a.txt");
    // A non-zero value on an operation without a result is a protocol violation, never silently accepted.
    await expect(files.link("/a", "/b")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(client.numbers).toEqual([90, 91, 76, 77, 88, 89, 86]);
  } finally { client.dispose(); }
});
