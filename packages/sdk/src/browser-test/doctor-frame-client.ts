import { DOCTOR_FRAME_PROBE } from "../contracts/doctor-frame.js";
import type { FrameMountProbe, FramePageProbe } from "../contracts/doctor-frame.js";
import { mountRuntimeFrame } from "../frame/client/iframe.js";
import { detectBrowserSupport } from "../runtime/browser-support.js";
import { VMError } from "../runtime/errors.js";

// The deployment doctor's probe for an application that runs OxideVM through the hosted runtime frame (ADR 0021).
// The doctor evaluates this bundle in the application's own page, so the page's headers, Content-Security-Policy
// and permissions apply to it as they do to the SDK client the application bundles, whose own code mounts the frame
// here. The doctor decodes what these functions return (contracts/doctor-frame.ts).

function page(): FramePageProbe {
  const support = detectBrowserSupport();
  // The SDK's frame client refuses a page that is not cross-origin isolated before it mounts the frame.
  return { secureContext: isSecureContext, crossOriginIsolated, missingFeatures: support.supported ? [] : support.missing };
}

function sameOrigin(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}

async function frame(origin: string): Promise<FrameMountProbe> {
  const controller = new AbortController(); let blockedBy: string | null = null;
  // A blocked frame never answers: stop waiting at the page's enforced violation report instead.
  const violation = (event: SecurityPolicyViolationEvent) => {
    if (event.disposition !== "enforce" || !sameOrigin(event.blockedURI, origin)) return;
    blockedBy = event.effectiveDirective; controller.abort();
  };
  document.addEventListener("securitypolicyviolation", violation);
  try {
    const mounted = await mountRuntimeFrame(origin, controller.signal);
    // The doctor creates no VM: closing the port and removing the frame end the connection.
    mounted.port.close(); mounted.remove();
    return { kind: "accepted", engineReleaseId: mounted.engineReleaseId };
  } catch (error: unknown) {
    return { kind: "failed", code: error instanceof VMError ? error.code : "PROTOCOL_ERROR", message: error instanceof VMError ? error.message : "the runtime frame failed in the page", blockedBy };
  } finally { document.removeEventListener("securitypolicyviolation", violation); }
}

Reflect.set(globalThis, Symbol.for(DOCTOR_FRAME_PROBE), { page, frame });
