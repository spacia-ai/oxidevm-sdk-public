import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeLinuxSignal, decodeSignalScope, type LinuxSignal, type SignalScope } from "../process-signals.js";

export type ProcessControl =
  | { readonly kind: "signal"; readonly signal: LinuxSignal; readonly scope: SignalScope }
  | { readonly kind: "resize"; readonly columns: number; readonly rows: number }
  | { readonly kind: "interrupt" };

export function decodeProcessControl(input: unknown): ProcessControl {
  const control = record(input, "process control");
  switch (control["kind"]) {
    case "signal":
      exactKeys(control, ["kind", "signal", "scope"]);
      return { kind: "signal", signal: decodeLinuxSignal(control["signal"]), scope: decodeSignalScope(control["scope"]) };
    case "resize":
      exactKeys(control, ["kind", "columns", "rows"]);
      return { kind: "resize", columns: integer(control["columns"], "terminal columns", 1, 1000), rows: integer(control["rows"], "terminal rows", 1, 1000) };
    case "interrupt":
      exactKeys(control, ["kind"]); return { kind: "interrupt" };
    default: throw new VMError("PROTOCOL_ERROR", "unknown process control");
  }
}
