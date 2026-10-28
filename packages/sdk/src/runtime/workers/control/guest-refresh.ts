import { AgentKind, encodeAgentReseed, encodeAgentSetTime } from "../../agent-protocol.js";
import { VMError } from "../../errors.js";
import { type CommandAgent, runAgentCommand } from "./agent-command.js";

/** The fallback command's exit status when `date` refused to set the clock. */
const CLOCK_NOT_SET_EXIT = 3;

/** The guest-agent operations a restored guest's refresh uses. */
export interface GuestRefreshAgent extends CommandAgent {
  /** Whether the agent sets the time and reseeds entropy itself (guest 7 `resume`). */
  readonly resumeCapable: boolean;
  /** Sends one request and resolves with the reply payload; a refused request rejects. */
  readonly request: (kind: number, payload: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
}

/**
 * Mixes `entropy` into a restored guest's pool and steps its wall clock to the host's, read from
 * `now` (ADR 0014 R7 and R8): a restore pauses guest time at the capture, and every copy of a
 * snapshot starts with the same random state. The reseed goes first because the first request
 * after a restore waits for the guest to wake (about a second on an idle guest); a clock step
 * sent then would land that much behind the host. Agents built before the `resume` capability
 * run the same steps as one shell process (each guest process start costs several hundred
 * milliseconds under emulation): `date`, then a write of `entropy` to `/dev/urandom`.
 */
export async function refreshRestoredGuest(
  agent: GuestRefreshAgent,
  now: () => number,
  entropy: Uint8Array,
): Promise<void> {
  if (agent.resumeCapable) {
    expectEmpty(await agent.request(AgentKind.reseedEntropy, encodeAgentReseed(entropy)));
    expectEmpty(await agent.request(AgentKind.setTime, encodeAgentSetTime(now())));
    return;
  }
  // BusyBox's portable "YYYY-MM-DD hh:mm:ss" form, not the optional "@seconds".
  const time = new Date(now()).toISOString();
  const script = `date -u -s '${time.slice(0, 10)} ${time.slice(11, 19)}' >/dev/null || exit ${String(CLOCK_NOT_SET_EXIT)}; exec cat > /dev/urandom`;
  const termination = await runAgentCommand(agent, ["sh", "-c", script], entropy);
  if (termination.kind === "exit" && termination.code === 0) return;
  throw refreshFailed(
    termination.kind === "exit" && termination.code === CLOCK_NOT_SET_EXIT ? "clock-not-set" : "entropy-not-reseeded",
    "the guest's refresh command failed",
  );
}

/** Why bringing a restored guest up to date failed. */
type RefreshFailure = "clock-not-set" | "entropy-not-reseeded";

function refreshFailed(reason: RefreshFailure, message: string): VMError {
  return new VMError("GUEST_CRASH", `${message}, so the restored guest is not up to date`, { reason });
}

function expectEmpty(payload: Uint8Array): void {
  if (payload.byteLength !== 0) throw new VMError("PROTOCOL_ERROR", "guest agent reply has unexpected data");
}
