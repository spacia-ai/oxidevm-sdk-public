import type { CoreRunExit } from "../core-abi.js";
import { VMError } from "../errors.js";

/** Retain exact core failure attribution across the worker adapter boundary. */
export function coreFailureError(exit: Extract<CoreRunExit, { kind: "internal-failure" }>): VMError {
  const failure = exit.failure;
  const detail = { coreSteps: exit.steps.toString(), ...(failure === undefined ? {} : { failure }) };
  switch (failure?.kind) {
    case "unsupported-semantic":
    case "unsupported-profile":
    case "unsupported-system-management-interrupt":
      return new VMError("UNSUPPORTED_INSTRUCTION", `core execution failed: ${failure.kind}`, detail);
    case "entropy-replay":
      return new VMError("VM_FAULT", `instruction entropy replay failed: ${failure.reason}`, detail);
    case "unexpected-adapter-exit":
      return new VMError("VM_FAULT", "core execution reached an unexpected adapter exit", detail);
    case undefined:
      return new VMError("VM_FAULT", "historical core record has no internal failure identity", detail);
  }
}
