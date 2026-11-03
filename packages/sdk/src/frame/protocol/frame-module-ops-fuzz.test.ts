import { describe, expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { hostileValue, mutate, Random, SizedBlob } from "../../runtime/fuzz.test-support.js";
import { RUNNER_LAUNCH_DESCRIPTOR_BYTES } from "../../runtime/js-process/launch.js";
import { isCopyKey, MODULE_COPY_BYTES, MODULE_FILES_PER_REQUEST } from "../../runtime/protocol/userspace-module-files.js";
import { MODULE_COMMAND_MAX_CONCURRENCY } from "../../runtime/userspace-module-commands-abi.js";
import { FRAME_PROTOCOL_VERSION } from "./handshake.js";
import { decodeFrameMessage, type FrameMessage } from "./requests.js";

// Seeded fuzzing of frame protocol 17's module operations (engine ADR 0028, plan SL-I12): the page is untrusted from
// the hosted runtime frame's side, so `module.files`, `module.spawn` and `module.commands` are mutated field by field
// from valid messages. Every input either decodes to a message inside the protocol's bounds or fails with a VMError;
// nothing else is thrown, nothing outside the bounds is accepted, and decoding is a pure function of its input.

const SEEDS = 24, ITERATIONS = 400;
const key = (index: number, bytes = 4): string => `${index.toString(16).padStart(64, "0")}:${String(bytes)}`;

function validMessages(random: Random, io: MessagePort): readonly Readonly<Record<string, unknown>>[] {
  const files = Object.fromEntries(Array.from({ length: random.below(MODULE_FILES_PER_REQUEST + 1) }, (_, index) => [key(index), new Blob([Uint8Array.of(1, 2, 3, 4)])]));
  const pins = Array.from({ length: random.below(MODULE_FILES_PER_REQUEST + 1) }, (_, index) => ({ sha256: index.toString(16).padStart(64, "c"), bytes: random.below(1024) }));
  return [
    { v: FRAME_PROTOCOL_VERSION, id: 1 + random.below(1000), type: "module.files", pins },
    { v: FRAME_PROTOCOL_VERSION, id: 1 + random.below(1000), type: "module.spawn", descriptor: "{\"v\":1}", files, io, args: ["a", "b"], cwd: "/workspace", env: { MODE: "x" } },
    { v: FRAME_PROTOCOL_VERSION, id: 1 + random.below(1000), type: "module.commands", request: { operation: "enable", descriptor: "{}", commands: ["python"], concurrency: 1 + random.below(MODULE_COMMAND_MAX_CONCURRENCY), files } },
    { v: FRAME_PROTOCOL_VERSION, id: 1 + random.below(1000), type: "module.commands", request: { operation: random.pick(["disable", "status"]), registration: 1 + random.below(100) } },
  ];
}

/** The nested request of module.commands is mutated too, half of the time. */
function hostile(random: Random, valid: Readonly<Record<string, unknown>>): unknown {
  // A tenth of the inputs stay valid: they must decode, so the bounds are checked on accepted messages too.
  if (random.chance(0.1)) return valid;
  if (random.chance(0.05)) return hostileValue(random);
  const nested = valid["request"];
  if (typeof nested === "object" && nested !== null && random.chance(0.5)) {
    const inner = Object.fromEntries(Object.entries(nested));
    return { ...valid, request: mutate(random, inner, Object.keys(inner)) };
  }
  if (valid["type"] === "module.spawn" && random.chance(0.3)) {
    // File maps at and beyond their bounds: count, key shape, value type, and total size.
    const count = random.pick([MODULE_FILES_PER_REQUEST, MODULE_FILES_PER_REQUEST + 1, 2]);
    const files: Record<string, unknown> = {};
    for (let index = 0; index < count; index++) files[random.chance(0.9) ? key(index) : String(hostileValue(random))] = random.chance(0.8) ? new SizedBlob(random.pick([4, 300 * 1024 ** 2])) : hostileValue(random);
    return { ...valid, files };
  }
  return mutate(random, valid, Object.keys(valid));
}

/** The bounds a decoded module message must satisfy, whatever produced it. Other operations a mutated type reached are
 * the other decoders' business (protocol.test.ts). */
function assertInBounds(message: FrameMessage): void {
  expect(Number.isSafeInteger(message.id) && message.id >= 1).toBe(true);
  if (message.type !== "module.files" && message.type !== "module.spawn" && message.type !== "module.commands") return;
  switch (message.type) {
    case "module.files":
      expect(message.pins.length).toBeLessThanOrEqual(MODULE_FILES_PER_REQUEST);
      for (const pin of message.pins) { expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/u); expect(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0 && pin.bytes <= MODULE_COPY_BYTES).toBe(true); expect(Object.keys(pin).sort()).toEqual(["bytes", "sha256"]); }
      return;
    case "module.spawn": {
      const entries = Object.entries(message.files);
      expect(entries.length).toBeLessThanOrEqual(MODULE_FILES_PER_REQUEST);
      expect(entries.reduce((total, [name, blob]) => { expect(isCopyKey(name)).toBe(true); expect(blob).toBeInstanceOf(Blob); return total + blob.size; }, 0)).toBeLessThanOrEqual(MODULE_COPY_BYTES);
      expect(typeof message.descriptor === "string" && new TextEncoder().encode(message.descriptor).byteLength <= RUNNER_LAUNCH_DESCRIPTOR_BYTES).toBe(true);
      expect(message.io).toBeInstanceOf(MessagePort);
      for (const arg of message.args ?? []) expect(typeof arg).toBe("string");
      for (const value of Object.values(message.env ?? {})) expect(typeof value).toBe("string");
      expect(message.cwd === undefined || typeof message.cwd === "string").toBe(true);
      expect(Object.keys(message).every(name => ["type", "id", "descriptor", "files", "io", "args", "cwd", "env"].includes(name))).toBe(true);
      return;
    }
    case "module.commands": {
      const request = message.request;
      if (request.operation === "enable") {
        expect(request.concurrency >= 1 && request.concurrency <= MODULE_COMMAND_MAX_CONCURRENCY).toBe(true);
        expect(Object.keys(request.files).length).toBeLessThanOrEqual(MODULE_FILES_PER_REQUEST);
        for (const name of request.commands) expect(typeof name).toBe("string");
      } else expect(Number.isSafeInteger(request.registration) && request.registration >= 1).toBe(true);
      return;
    }
  }
}

describe("frame protocol 17 module operations under seeded fuzzing (ADR 0028)", () => {
  it(`decodes in bounds or refuses with a VMError (${String(SEEDS)} seeds x ${String(ITERATIONS)})`, () => {
    const io = new MessageChannel(), outcomes = { accepted: 0, refused: 0 };
    try {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const random = new Random(seed);
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
          const input = hostile(random, random.pick(validMessages(random, io.port1)));
          let first: FrameMessage | undefined;
          try { first = decodeFrameMessage(input); }
          catch (error: unknown) {
            if (!(error instanceof VMError)) throw new Error(`seed ${String(seed)} iteration ${String(iteration)}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, { cause: error });
            expect(["PROTOCOL_ERROR", "INVALID_ARGUMENT"]).toContain(error.code);
            outcomes.refused++;
            continue;
          }
          outcomes.accepted++;
          assertInBounds(first);
          // Pure: the same input decodes to the same message again.
          expect(decodeFrameMessage(input)).toEqual(first);
        }
      }
    } finally { io.port1.close(); io.port2.close(); }
    // Both outcomes occur, so the generator reaches both sides of every check it can.
    expect(outcomes.accepted).toBeGreaterThan(SEEDS * ITERATIONS / 20);
    expect(outcomes.refused).toBeGreaterThan(SEEDS * ITERATIONS / 2);
  });

  it("is deterministic: one seed produces the same accept/refuse sequence twice", () => {
    const io = new MessageChannel();
    const run = (): string => {
      const random = new Random(7), trace: string[] = [];
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        try { trace.push(decodeFrameMessage(hostile(random, random.pick(validMessages(random, io.port1)))).type); }
        catch (error: unknown) { trace.push(error instanceof VMError ? `refused:${error.code}` : "other"); }
      }
      return trace.join(",");
    };
    try { expect(run()).toBe(run()); } finally { io.port1.close(); io.port2.close(); }
  });
});
