import { describe, expect, it, vi } from "vitest";
import { ASSISTANCE_ENABLED, requireAssistanceAdmission, requireGuestExecution } from "./assistance-admission.js";
import { SystemAssistance } from "./workers/control/assistance.js";

describe("ordinary assistance admission", () => {
  it("rejects installation transport acquisition independently in the control build", async () => {
    const authority = vi.fn();
    const owner = new SystemAssistance({ supportsAssistance: true, startInstallation: vi.fn(), installation: vi.fn(), assistanceVersion: 6,
      assistance: authority, superviseAssistance: authority, creditAssistance: authority,
      checkAssistanceHealth: authority, setAssistanceEvents: authority, setInstallationEvents: authority,
    });
    await expect(owner.beginInstallation({ origin: "https://registry.npmjs.org", maximumBytes: 1024 })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    expect(authority).not.toHaveBeenCalled();
  });
  it("rejects before any worker can be started and ignores ambient enablement", () => {
    const worker = vi.fn();
    vi.stubGlobal("Worker", worker);
    vi.stubGlobal("ASSISTANCE_ENABLED", true);
    try {
      expect(ASSISTANCE_ENABLED).toBe(false);
      expect(requireAssistanceAdmission).toThrow("disabled in this SDK build");
      expect(() => requireGuestExecution({ kind: "assisted-node", profile: "node24-next16-v1" })).toThrow("disabled");
      expect(worker).not.toHaveBeenCalled();
      expect(() => requireGuestExecution(undefined)).not.toThrow();
      expect(() => requireGuestExecution({ kind: "guest" })).not.toThrow();
    } finally { vi.unstubAllGlobals(); }
  });
});
