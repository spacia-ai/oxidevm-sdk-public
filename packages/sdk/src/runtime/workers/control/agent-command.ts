import { deserializeError, VMError } from "../../errors.js";
import { decodeGuestProcessWireEvent, type ProcessTermination } from "../../protocol/agent.js";
import { PROTOCOL_VERSION } from "../../protocol/common.js";

/** How long a short command the control worker runs in the guest may take. */
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;

/** The guest-agent process operations a command the control worker runs for itself uses. */
export interface CommandAgent {
  /** Starts a process whose events and output acknowledgements use `port`. */
  readonly spawn: (command: string, args: readonly string[], port: MessagePort) => Promise<{ readonly pid: number }>;
  readonly writeStdin: (pid: number, data: Uint8Array) => Promise<void>;
  readonly closeStdin: (pid: number) => Promise<void>;
}

/**
 * Runs a short guest command for the control worker itself: it acknowledges the command's
 * output so it can finish, feeds `input` to its stdin, and resolves with its termination. A
 * command still running after 30 s fails as a GUEST_CRASH.
 */
export async function runAgentCommand(
  agent: CommandAgent,
  [command, ...args]: readonly [string, ...string[]],
  input: Uint8Array,
): Promise<ProcessTermination> {
  const { port1, port2 } = new MessageChannel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const termination = new Promise<ProcessTermination>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new VMError("GUEST_CRASH", `the guest's ${command} did not finish`, { reason: "guest-command-timeout" }));
    }, COMMAND_TIMEOUT_MILLISECONDS);
    port2.addEventListener("message", (event: MessageEvent<unknown>) => {
      try {
        const message = decodeGuestProcessWireEvent(event.data);
        if (message.type === "exit") resolve(message.termination);
        else if (message.type === "error") reject(deserializeError(message.error));
        else {
          port2.postMessage({
            version: PROTOCOL_VERSION,
            sessionId: message.sessionId,
            type: "output-ack",
            sequence: message.sequence,
          });
        }
      } catch (error) {
        reject(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", String(error)));
      }
    });
    port2.start();
  });
  try {
    const { pid } = await agent.spawn(command, args, port1);
    await agent.writeStdin(pid, input);
    await agent.closeStdin(pid);
    return await termination;
  } finally {
    clearTimeout(timer);
    termination.catch(() => undefined);
    port2.close();
  }
}
