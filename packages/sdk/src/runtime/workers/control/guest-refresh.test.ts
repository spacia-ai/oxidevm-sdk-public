import { afterEach, describe, expect, it } from "vitest";

import { AgentKind } from "../../agent-protocol.js";
import { PROTOCOL_VERSION } from "../../protocol.js";
import { type GuestRefreshAgent, refreshRestoredGuest } from "./guest-refresh.js";

const NOW = Date.parse("2026-10-05T19:05:33.250Z");
const ENTROPY = new Uint8Array(64).map((_, index) => index + 1);
const ports: MessagePort[] = [];

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: number[];
  /** Reports the exit once the output is acknowledged and, for `sh`, stdin is closed. */
  readonly settle: (event: "acked" | "stdin-closed") => void;
}

/**
 * An agent that records what a refresh asks of it. Its processes print one line, which must be
 * acknowledged before they report `exitCode`.
 */
function agent(resumeCapable: boolean, exitCode = 0) {
  const log: string[] = [];
  const requests: { readonly kind: number; readonly payload: Uint8Array }[] = [];
  const spawned: Spawned[] = [];
  const fake: GuestRefreshAgent = {
    resumeCapable,
    request: (kind, payload) => {
      log.push(`request ${String(kind)}`);
      requests.push({ kind, payload });
      return Promise.resolve(new Uint8Array());
    },
    spawn: (command, args, port) => {
      log.push(`spawn ${command}`);
      ports.push(port);
      const pending = new Set<string>(command === "sh" ? ["acked", "stdin-closed"] : ["acked"]);
      const process: Spawned = {
        command,
        args,
        stdin: [],
        settle: (event) => {
          pending.delete(event);
          if (pending.size !== 0) return;
          port.postMessage({
            version: PROTOCOL_VERSION,
            sessionId: 9,
            sequence: 2,
            type: "exit",
            termination: { kind: "exit", code: exitCode },
          });
        },
      };
      spawned.push(process);
      port.addEventListener("message", (event: MessageEvent<unknown>) => {
        const ack = event.data;
        if (typeof ack === "object" && ack !== null && Reflect.get(ack, "type") === "output-ack") {
          process.settle("acked");
        }
      });
      port.start();
      port.postMessage({
        version: PROTOCOL_VERSION,
        sessionId: 9,
        sequence: 1,
        type: "stdout",
        data: new TextEncoder().encode("done\n"),
      });
      return Promise.resolve({ pid: 40 + spawned.length });
    },
    writeStdin: (pid, data) => {
      log.push(`stdin ${String(pid)} ${String(data.byteLength)}`);
      spawned.at(-1)?.stdin.push(...data);
      return Promise.resolve();
    },
    closeStdin: (pid) => {
      log.push(`close-stdin ${String(pid)}`);
      spawned.at(-1)?.settle("stdin-closed");
      return Promise.resolve();
    },
  };
  return { fake, log, requests, spawned };
}

describe("restored guest refresh", () => {
  afterEach(() => {
    for (const port of ports.splice(0)) port.close();
  });

  it("reseeds entropy, then steps the clock to the host's time as it sends the step", async () => {
    const guest = agent(true);
    let now = NOW;
    // The first request after a restore waits for the guest to wake: here, a second and a half.
    const slow: GuestRefreshAgent = {
      ...guest.fake,
      request: async (kind, payload) => {
        const reply = await guest.fake.request(kind, payload);
        now += 1_500;
        return reply;
      },
    };

    await refreshRestoredGuest(slow, () => now, ENTROPY);

    expect(guest.log).toEqual([`request ${String(AgentKind.reseedEntropy)}`, `request ${String(AgentKind.setTime)}`]);
    expect(guest.requests[0]?.payload).toEqual(ENTROPY);
    const time = new DataView(guest.requests[1]?.payload.buffer ?? new ArrayBuffer(12));
    expect(time.getBigInt64(0, true)).toBe(BigInt(Math.floor((NOW + 1_500) / 1_000)));
    expect(time.getUint32(8, true)).toBe(750_000_000);
  });

  it("sets the date and feeds the entropy pool with one process when the agent predates resume", async () => {
    const guest = agent(false);

    await refreshRestoredGuest(guest.fake, () => NOW, ENTROPY);

    // One process: every guest process start costs several hundred milliseconds under emulation.
    expect(guest.spawned.map(({ command, args }) => [command, ...args])).toEqual([
      ["sh", "-c", "date -u -s '2026-10-05 19:05:33' >/dev/null || exit 3; exec cat > /dev/urandom"],
    ]);
    expect(guest.spawned[0]?.stdin).toEqual([...ENTROPY]);
    expect(guest.log).toEqual(["spawn sh", "stdin 41 64", "close-stdin 41"]);
    expect(guest.requests).toEqual([]);
  });

  it("tells a date the guest refused from an entropy write that failed", async () => {
    await expect(refreshRestoredGuest(agent(false, 3).fake, () => NOW, ENTROPY)).rejects.toMatchObject({
      code: "GUEST_CRASH",
      detail: { reason: "clock-not-set" },
    });
    await expect(refreshRestoredGuest(agent(false, 1).fake, () => NOW, ENTROPY)).rejects.toMatchObject({
      code: "GUEST_CRASH",
      detail: { reason: "entropy-not-reseeded" },
    });
  });
});
