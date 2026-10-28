import { VMError } from "./errors.js";
import type { ProcessExecution } from "./vm-types.js";
import { ASSISTANCE_BUILD } from "./assistance-build.js";

/** Normal SDK builds cannot admit browser-assisted work. */
export const ASSISTANCE_ENABLED = ASSISTANCE_BUILD === "development";

export function requireAssistanceAdmission(): void {
  if (ASSISTANCE_ENABLED) return;
  throw new VMError("FEATURE_NOT_AVAILABLE", "Assistance is disabled in this SDK build", {
    backend: "assisted-node", profile: "node24-next16-v1", reason: "build-disabled",
  });
}

export function requireGuestExecution(execution: ProcessExecution | undefined): void {
  if (execution?.kind === "assisted-node") {
    requireAssistanceAdmission();
    throw new VMError("FEATURE_NOT_AVAILABLE", "Assisted execution requires its dedicated system backend", {
      backend: "assisted-node", profile: "node24-next16-v1", reason: "capability-missing",
    });
  }
}
