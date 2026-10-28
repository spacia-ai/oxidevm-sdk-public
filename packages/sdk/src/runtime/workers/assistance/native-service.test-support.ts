import { spawn } from "node:child_process";
import type { Buffer } from "node:buffer";
import { createAsyncContext } from "./async-context.js";
import { createNativeChildren } from "./node-children.js";
import type { AssistanceEvent } from "../../protocol/assistance-event.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

/** Real Node child processes behind the same typed child boundary used by workers. */
export function nativeServiceFixture() {
  const context = createAsyncContext();
  let receive: ((event: AssistanceEvent) => void) | undefined;
  let sequence = 0, nextChild = 0, references = 0;
  const children = new Map<number, ReturnType<typeof spawn>>();
  const emit = (event: AssistanceEvent["event"]) => {
    if (receive === undefined) throw new Error("Missing child receiver");
    receive({ session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1, sequence: ++sequence, event });
  };
  const native = createNativeChildren({ setChildEvents(callback) { receive = callback; },
    callSync(operation): AssistanceResult {
      if (operation.kind === "signal") {
        const child = children.get(operation.child);
        if (child?.kill(`SIG${operation.signal}`) === true) return { kind: "unit" };
        return { kind: "error", errno: 3, code: "ESRCH", syscall: "signal", path: null, destination: null };
      }
      if (operation.kind !== "spawn" || operation.command !== "/usr/bin/node") throw new Error("Unexpected native service command");
      const id = ++nextChild;
      const child = spawn(process.env["OXIDEVM_TEST_NODE"] ?? process.execPath, [...operation.args]);
      if (child.pid === undefined) throw new Error("Missing native process");
      children.set(id, child);
      for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
        stream.on("data", (bytes: Buffer) => {
          for (let offset = 0; offset < bytes.length; offset += 16384) emit({ kind: "output", child: id, stream: name, bytes: Uint8Array.from(bytes.subarray(offset, offset + 16384)) });
        });
        stream.on("end", () => emit({ kind: "eof", child: id, stream: name }));
      }
      child.on("exit", (code, signal) => emit(signal === null ? { kind: "exit", child: id, code: code ?? 1, signal: null } : { kind: "exit", child: id, code: null, signal: signal === "SIGKILL" ? 9 : 15 }));
      return { kind: "spawned", child: id, pid: child.pid };
    },
    async call(operation): Promise<AssistanceResult> {
      if (!("child" in operation)) throw new Error("Unexpected service operation");
      const child = children.get(operation.child);
      if (child === undefined || child.stdin === null) throw new Error("Missing native child");
      const stdin = child.stdin;
      if (operation.kind === "stdin") {
        await new Promise<void>((resolve, reject) => stdin.write(operation.bytes, error => error ? reject(error) : resolve()));
        return { kind: "written", count: operation.bytes.length };
      }
      if (operation.kind === "close-stdin") stdin.end();
      else if (operation.kind === "signal") child.kill(operation.signal === "KILL" ? "SIGKILL" : "SIGTERM");
      return { kind: "unit" };
    },
  }, context, {});
  return { native, context, retain: () => { references++; return () => { references--; }; },
    references: () => references, dispose: () => { for (const child of children.values()) child.kill("SIGKILL"); } };
}
