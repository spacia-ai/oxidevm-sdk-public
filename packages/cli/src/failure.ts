import { VMError } from "@oxidevm/sdk";

const GENERIC = "operation failed; check the selected files and installed tools";

/**
 * The text for a failed command. Raw filesystem and tool errors can include author paths or secrets, so an
 * error that is not an SDK error contributes only its errno name (for example ENOSPC), never its message.
 */
export function failureMessage(error: unknown): string {
  if (error instanceof VMError) return error.message;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]{1,15}$/u.test(error.code)) {
    return `operation failed (${error.code}); check the selected files and installed tools`;
  }
  return GENERIC;
}
