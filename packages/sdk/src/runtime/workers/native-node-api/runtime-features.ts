import type { NativeProcessProfile } from "../../userspace-command-abi.js";
import type { ProcessBuildProperty } from "../assistance/node-process.js";

// Captured from the authenticated Node24.18.1/Bun1.3.14 binaries, not browser capability guesses.
const common = { inspector: true, debug: false, uv: true, ipv6: true, tls_alpn: true, tls_sni: true, tls_ocsp: true, tls: true };

export function nativeBuildFeatures(runtime: NativeProcessProfile["runtime"]): ProcessBuildProperty {
  if (runtime === "bun") return {
    value: { ...common, cached_builtins: true, openssl_is_boringssl: true, require_module: true, typescript: "transform" },
    writable: true, configurable: true,
  };
  // Admission permits only source-map flags; they do not change these option-dependent values.
  const value = {
    ...common, openssl_is_boringssl: false,
    get cached_builtins() { return true; },
    get require_module() { return true; },
    get quic() { return false; },
  };
  Object.defineProperty(value, "typescript", { get() { return "strip"; }, enumerable: true, configurable: true });
  return { value, writable: false, configurable: false };
}
