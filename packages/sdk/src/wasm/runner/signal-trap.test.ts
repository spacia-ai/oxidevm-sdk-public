import { describe, expect, it } from "vitest";
import { realtimeSignalName, realtimeSignalNumber, signalNumber } from "../../runtime/process-signals.js";
import { fakeSignals } from "../testing/memory-signals.js";
import { RunnerSignals } from "./signals.js";

/** Calls `trap` with an argument its type would not allow, as an adapter written in JavaScript can. */
async function untypedTrap(signals: RunnerSignals, input: unknown): Promise<unknown> {
  const trap: unknown = Reflect.get(signals.api, "trap");
  if (typeof trap !== "function") throw new Error("no trap");
  const result: unknown = await Reflect.apply(trap, signals.api, [input]);
  return result;
}

describe("real-time signal names (process-signals.ts)", () => {
  it("maps SIGRTMIN, SIGRTMIN+n, SIGRTMAX-n and SIGRTMAX to 35..64 and names each number canonically", () => {
    expect(["SIGRTMIN", "SIGRTMIN+1", "SIGRTMIN+29", "SIGRTMAX-29", "SIGRTMAX-1", "SIGRTMAX"].map(realtimeSignalNumber)).toEqual([35, 36, 64, 35, 63, 64]);
    for (const input of ["SIGRTMIN+30", "SIGRTMAX-30", "SIGRTMIN+0", "SIGRTMIN+01", "SIGRTMIN-1", "SIGRT", 36, undefined]) expect(realtimeSignalNumber(input), String(input)).toBeNull();
    expect([35, 36, 50, 51, 63, 64].map(realtimeSignalName)).toEqual(["SIGRTMIN", "SIGRTMIN+1", "SIGRTMIN+15", "SIGRTMAX-13", "SIGRTMAX-1", "SIGRTMAX"]);
    for (let number = 35; number <= 64; number++) expect(realtimeSignalNumber(realtimeSignalName(number))).toBe(number);
    for (const number of [0, 32, 34, 65, 35.5]) expect(realtimeSignalName(number)).toBeNull();
    expect([signalNumber("SIGINT"), signalNumber("SIGRTMIN+1"), signalNumber(36), signalNumber(34), signalNumber("SIGINT ")]).toEqual([2, 36, 36, null, null]);
  });
});

describe("real-time traps", () => {
  it("yields a standard signal's name and each real-time arrival with its details, in order", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    const trap = await signals.api.trap(["SIGINT", "SIGRTMIN+1"]);
    expect(trap.signals).toEqual(["SIGINT", 36]);
    expect(transport.calls).toEqual([[2, "caught"], [36, "caught"]]);
    const queued = (value: bigint) => ({ signal: 36, details: { code: -1, sender: 41, uid: 1000, value } } as const);
    transport.arrive([{ signal: 2, details: null }, queued(1n), queued(2n)]);
    transport.arrive([queued(3n), { signal: 36, details: null }]);
    const iterator = trap[Symbol.asyncIterator](), taken: unknown[] = [];
    for (let index = 0; index < 5; index++) taken.push((await iterator.next()).value);
    expect(taken).toEqual([
      "SIGINT",
      { signal: 36, value: 1n, code: -1, pid: 41, uid: 1000 }, { signal: 36, value: 2n, code: -1, pid: 41, uid: 1000 }, { signal: 36, value: 3n, code: -1, pid: 41, uid: 1000 },
      // An arrival past the queue limit lost its siginfo: Linux reports SI_USER zeros.
      { signal: 36, value: 0n, code: 0, pid: 0, uid: 0 },
    ]);
  });

  it("refuses a list naming one number twice, and real-time names or numbers outside 35..64", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport), refused = { code: "INVALID_ARGUMENT" };
    for (const input of [["SIGRTMIN+1", 36], ["SIGRTMAX", "SIGRTMIN+29"], ["SIGRTMIN+30"], [34], [65], ["SIGKILL"], ["SIGSTOP"], [2]]) {
      await expect(untypedTrap(signals, input), JSON.stringify(input)).rejects.toMatchObject(refused);
    }
    expect(transport.calls).toEqual([]);
  });

  it("raises a real-time signal by name or number as kill(getpid())", async () => {
    const transport = fakeSignals(), signals = new RunnerSignals(transport);
    const trap = await signals.api.trap([40]);
    await signals.api.raise("SIGRTMIN+5");
    expect(transport.kills).toEqual([40]);
    expect(await trap[Symbol.asyncIterator]().next()).toEqual({ value: { signal: 40, value: 0n, code: 0, pid: 7, uid: 1000 }, done: false });
  });
});
