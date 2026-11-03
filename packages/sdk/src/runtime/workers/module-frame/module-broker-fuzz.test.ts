import { afterEach, describe, expect, it, vi } from "vitest";
import { JS_MAILBOX_BYTES, JS_MAX_OPERATION, JS_PROCESS_PROTOCOL_VERSION } from "../../js-process/codec.js";
import { hostileValue, mutate, Random } from "../../fuzz.test-support.js";
import { MODULE_BROKER_VERSION } from "../../protocol/module-frame.js";
import { MODULE_BROKER_PROCESSES } from "./broker.js";
import { brokerWith, request, reply, spawn, type FakeRunner } from "./broker.test-support.js";

// Seeded fuzzing of the module frame's broker (engine ADR 0028, plan SL-I12). A runner runs the module's code, so every
// message it posts on its relay port is hostile; the broker must end at most the process that sent it, keep relaying
// for every other process, never hand shared memory or a synchronous request upstream, and give the process's place
// back to its budget. An exception escaping a handler fails the test as an unhandled error; the runner's own posts to
// the broker (forwarded as they are) are part of the surface.

afterEach(() => { vi.restoreAllMocks(); });

const SEEDS = 12, VICTIMS = 12, MESSAGES = 6;
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 2); });

/** What a hostile runner posts on its relay port: mutated requests, malformed local messages, or anything at all. */
function hostileRunnerMessage(random: Random, sequence: number): unknown {
  switch (random.below(8)) {
    case 0: return hostileValue(random);
    case 1: return mutate(random, { type: "signaled", version: JS_PROCESS_PROTOCOL_VERSION, signal: random.pick([2, 9, 15, 0, 64]) }, ["type", "version", "signal"]);
    case 2: return { ...request(random.pick([sequence, sequence + 2, 0, -1, 2 ** 31]), random.chance(0.5)), operation: random.pick([0, JS_MAX_OPERATION, JS_MAX_OPERATION + 1, -1, 1.5]) };
    case 3: return { ...request(sequence, true), payload: random.chance(0.02) ? new Uint8Array(JS_MAILBOX_BYTES + 1) : hostileValue(random) };
    case 4: return { ...request(sequence, true), mailbox: new SharedArrayBuffer(8) };
    case 5: return request(sequence, random.chance(0.5));
    default: return mutate(random, request(sequence, random.chance(0.5)), ["version", "type", "sequence", "sync", "operation", "payload"]);
  }
}

/** Hostile input from the Userspace side, at a lower rate: replies for unknown sequences, notices and a second start. */
function hostileUpstream(random: Random, sequence: number): unknown {
  switch (random.below(4)) {
    case 0: return mutate(random, reply(sequence), ["version", "type", "sequence", "errno", "value", "payload"]);
    case 1: return { version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: random.pick([2, 9, 15, 100]), interrupt: hostileValue(random) };
    case 2: return reply(sequence + 50);
    default: return hostileValue(random);
  }
}

interface Watched { readonly errors: unknown[]; readonly relayed: unknown[]; readonly violations: string[] }

/** Collects what a process's channel and service port receive, recording each message that breaks the broker's rules. */
function watch(process: Awaited<ReturnType<typeof spawn>>): Watched {
  const watched: Watched = { errors: [], relayed: [], violations: [] };
  const rule = (holds: boolean, text: string): void => { if (!holds) watched.violations.push(text); };
  process.channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    // The broker forwards runner messages as `message`; its own reports are `error`, after the runner is gone.
    if (typeof data === "object" && data !== null && Reflect.get(data, "type") === "error") {
      rule(Object.keys(data).sort().join() === "message,type,version", `error fields ${Object.keys(data).join()}`);
      rule(String(Reflect.get(data, "message")).length <= 1024, "error message over 1024 characters");
      rule(process.runner.terminated, "an error was reported while the runner still ran");
      watched.errors.push(data);
    }
  });
  process.channel.start();
  process.service.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    // Nothing synchronous and no shared memory crosses to the Userspace worker: requests arrive asynchronous and bounded.
    if (typeof data === "object" && data !== null && Reflect.get(data, "type") === "request") {
      rule(Object.keys(data).sort().join() === "operation,payload,sequence,sync,type,version", `relayed request fields ${Object.keys(data).join()}`);
      rule(Reflect.get(data, "sync") === false, "a synchronous request was relayed upstream");
      const payload: unknown = Reflect.get(data, "payload");
      rule(payload instanceof Uint8Array && payload.byteLength <= JS_MAILBOX_BYTES, "a relayed payload is not a bounded Uint8Array");
    }
    watched.relayed.push(data);
  });
  process.service.start();
  return watched;
}

describe("the module broker under seeded fuzzing (ADR 0028)", () => {
  it(`a hostile runner fails only its own process (${String(SEEDS)} seeds x ${String(VICTIMS)} processes x ${String(MESSAGES)} messages)`, async () => {
    let failedProcesses = 0, survivingProcesses = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = new Random(seed), { port, runners } = brokerWith(), healthy = await spawn(port, runners, 1), healthyWatch = watch(healthy);
      let healthySequence = 0;
      for (let victimIndex = 0; victimIndex < VICTIMS; victimIndex++) {
        const victim = await spawn(port, runners, 100 + victimIndex), watched = watch(victim);
        // A fifth of the processes behave: their requests must all be relayed, and none of them is ended.
        let sequence = 1;
        const benign = random.chance(0.2);
        for (let index = 0; index < MESSAGES; index++) {
          if (benign) victim.port.postMessage(request(sequence++, false));
          else if (random.chance(0.15)) { try { victim.service.postMessage(hostileUpstream(random, sequence)); } catch { /* not cloneable */ } }
          else if (random.chance(0.05)) victim.runner.onmessageerror?.(new MessageEvent("messageerror"));
          // What the runner posts to the broker itself, which forwards it: anything, including a port it did not transfer.
          else if (random.chance(0.12)) victim.runner.onmessage?.(new MessageEvent("message", { data: random.chance(0.4) ? { version: JS_PROCESS_PROTOCOL_VERSION, type: "request", port: new MessageChannel().port1 } : hostileValue(random) }));
          else {
            const message = hostileRunnerMessage(random, sequence);
            try { victim.port.postMessage(message); } catch { /* not cloneable: the runner could not have sent it either */ }
            if (typeof message === "object" && message !== null && Reflect.get(message, "type") === "request" && Reflect.get(message, "sequence") === sequence) sequence++;
          }
        }
        await flush();
        // The healthy process still relays, in sequence, with its own mailbox.
        healthy.port.postMessage(request(++healthySequence, false));
        await vi.waitFor(() => { expect(healthyWatch.relayed.filter(entry => typeof entry === "object" && entry !== null && Reflect.get(entry, "sequence") === healthySequence)).toHaveLength(1); }, { interval: 2 });
        expect(healthy.runner.terminated).toBe(false);
        expect(healthyWatch.errors).toEqual([]);
        expect(healthyWatch.violations).toEqual([]);
        if (benign) await vi.waitFor(() => { expect(watched.relayed).toHaveLength(MESSAGES); }, { interval: 2 });
        if (benign) expect(watched.errors).toEqual([]);
        if (watched.errors.length > 0) failedProcesses++; else survivingProcesses++;
        expect(watched.errors.length).toBeLessThanOrEqual(1);
        expect(watched.violations, `seed ${String(seed)} process ${String(victimIndex)}`).toEqual([]);
        // Whatever happened, the Userspace side ends the process; its place returns to the budget.
        victim.channel.postMessage({ version: MODULE_BROKER_VERSION, type: "stop" });
        await vi.waitFor(() => { expect(victim.runner.terminated).toBe(true); }, { interval: 2 });
      }
      // Every victim's place is free again: the broker serves its limit once more, and refuses one beyond it.
      const extra: FakeRunner[] = [];
      for (let pid = 0; pid < MODULE_BROKER_PROCESSES - 1; pid++) extra.push((await spawn(port, runners, 5000 + pid)).runner);
      const channel = new MessageChannel(), refused = new Promise<unknown>(resolve => { channel.port1.onmessage = event => { resolve(event.data); }; });
      port.postMessage({ version: MODULE_BROKER_VERSION, type: "spawn", pid: 9999, port: channel.port2 }, [channel.port2]);
      expect(await refused).toMatchObject({ type: "error", message: "Invalid module process launch" });
      expect(extra.every(runner => !runner.terminated)).toBe(true);
      channel.port1.close();
    }
    // The generator reaches both outcomes: processes it ended and processes whose messages were valid enough to keep.
    expect(failedProcesses).toBeGreaterThan(SEEDS * VICTIMS / 3);
    expect(survivingProcesses).toBeGreaterThan(0);
  }, 120_000);
});
