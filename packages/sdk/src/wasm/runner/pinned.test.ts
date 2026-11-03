import { describe, expect, it, vi } from "vitest";
import { COMMAND_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";
import { IntegrityError, readPinned, verifyPinned, type Fetcher } from "./pinned.js";

const release = (): Promise<Release> => buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "data.bin": Uint8Array.of(1, 2, 3, 4) }, declaration: COMMAND_DECLARATION });
const serve = (served: Release["served"]): Fetcher => url => {
  const bytes = served.get(url);
  return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice()));
};
const signal = () => new AbortController().signal;

async function data() {
  const built = await release(), pin = built.descriptor.artifacts["data.bin"];
  if (pin === undefined) throw new Error("no pin");
  return { built, pin };
}

describe("reading a pinned file on the page (ADR 0028)", () => {
  it("reads exactly the pin's bytes and hashes nothing", async () => {
    const { built, pin } = await data(), digest = vi.spyOn(crypto.subtle, "digest");
    expect(await readPinned(pin, "Artifact data.bin", "data.bin", serve(built.served), signal())).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });

  it("refuses a longer or shorter body as an integrity error naming the file", async () => {
    const { built, pin } = await data();
    for (const [bytes, message] of [[Uint8Array.of(1, 2, 3, 4, 5), /larger than its pin/u], [Uint8Array.of(1, 2, 3), /shorter than its pin/u]] as const) {
      const pending = readPinned(pin, "Artifact data.bin", "data.bin", serve(new Map([...built.served, [pin.url, Uint8Array.from(bytes)]])), signal());
      await expect(pending).rejects.toBeInstanceOf(IntegrityError);
      await expect(readPinned(pin, "Artifact data.bin", "data.bin", serve(new Map([[pin.url, Uint8Array.from(bytes)]])), signal())).rejects.toThrow(message);
    }
  });

  it("stops reading a body that exceeds its pin instead of buffering it", async () => {
    const { pin } = await data();
    let pulls = 0, cancelled = false;
    const endless: Fetcher = () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    })));
    await expect(readPinned(pin, "Artifact data.bin", "data.bin", endless, signal())).rejects.toBeInstanceOf(IntegrityError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(5);
  });

  it("distinguishes a missing file or a network failure from tampering", async () => {
    const { pin } = await data();
    await expect(readPinned(pin, "Artifact data.bin", "data.bin", serve(new Map()), signal())).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { reason: "wasm-module-artifact", file: "data.bin" } });
    const offline: Fetcher = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(readPinned(pin, "Artifact data.bin", "data.bin", offline, signal())).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { file: "data.bin" } });
  });

  it("passes the caller's cancellation to the fetch and rethrows it unchanged", async () => {
    const { pin } = await data(), controller = new AbortController(), seen = vi.fn();
    const hanging: Fetcher = (_url, init) => new Promise<Response>((_resolve, reject) => { seen(init.signal === controller.signal); init.signal.addEventListener("abort", () => { reject(init.signal.reason instanceof Error ? init.signal.reason : new Error("aborted")); }); });
    const pending = readPinned(pin, "Artifact data.bin", "data.bin", hanging, controller.signal);
    controller.abort(new Error("start stopped"));
    await expect(pending).rejects.toThrow("start stopped");
    expect(seen).toHaveBeenCalledWith(true);
  });
});

describe("checking a copy against its pin", () => {
  it("accepts the pinned bytes and names a file whose bytes or size differ", async () => {
    const { pin } = await data();
    await expect(verifyPinned(Uint8Array.of(1, 2, 3, 4), pin, "Artifact data.bin", "data.bin")).resolves.toBeUndefined();
    for (const [bytes, message] of [[Uint8Array.of(1, 2, 3, 5), /does not match its sha256 pin/u], [Uint8Array.of(1, 2, 3, 4, 5), /larger/u], [Uint8Array.of(1, 2, 3), /shorter/u]] as const) {
      await expect(verifyPinned(Uint8Array.from(bytes), pin, "Artifact data.bin", "data.bin")).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" }, message: expect.stringMatching(message) as unknown });
    }
  });
});
