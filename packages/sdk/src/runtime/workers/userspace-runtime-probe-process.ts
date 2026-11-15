import { VMError } from "../errors.js";
import { RUNTIME_PROBE_DEADLINE_MS } from "../js-process/runtime-probe.js";
import { admitInitialUserspaceProcess } from "./userspace-process-admission.js";
import { collectRuntimeProbe, type RuntimeProbeRun } from "./userspace-runtime-probes.js";

interface ProbeProcessPorts {
  readonly runtime: { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory };
  active(): boolean;
  serviceRead(signal: AbortSignal): Promise<boolean>;
  connect(pid: number, port: MessagePort): number;
  kill(pid: number): void;
  disconnect(pid: number): void;
}

/** Connects a Rust-admitted Linux probe to the normal output/acknowledgement path. */
export async function runRuntimeProbeProcess(ports: ProbeProcessPorts, sha256: string, cancelled: AbortSignal): Promise<RuntimeProbeRun> {
  const channel = new MessageChannel();
  const deadline = new AbortController();
  const timer = setTimeout(() => { deadline.abort(); }, RUNTIME_PROBE_DEADLINE_MS);
  const signal = AbortSignal.any([cancelled, deadline.signal]);
  let pid: number | undefined;
  const check = () => {
    if (!ports.active() || signal.aborted) throw new VMError("ABORTED", "Runtime probe admission cancelled");
  };
  try {
    pid = await admitInitialUserspaceProcess(ports.runtime, { kind: "runtime-probe", sha256 },
      { arguments: [], environment: [], cwd: "/" }, check, () => ports.serviceRead(signal));
    check();
    const probePid = pid;
    const sessionId = ports.connect(probePid, channel.port1);
    const result = await collectRuntimeProbe(channel.port2, sessionId, () => ports.kill(probePid), signal);
    return deadline.signal.aborted && !cancelled.aborted ? { ...result, ending: "timeout" } : result;
  } finally {
    clearTimeout(timer);
    try { if (pid !== undefined) ports.kill(pid); }
    finally {
      try { if (pid !== undefined) ports.disconnect(pid); }
      finally { channel.port1.close(); channel.port2.close(); }
    }
  }
}
