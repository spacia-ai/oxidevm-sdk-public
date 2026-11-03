import { describe, expect, it } from "vitest";
import { LinuxError } from "../../runtime/js-process/codec.js";
import { MODULE_EXIT } from "../exit-codes.js";
import { NetError, netError, notDeclared } from "../net/errors.js";
import { TlsError } from "../net/tls.js";
import { kit } from "./index.js";

const fetchFailure = (cause: unknown) => new TypeError("fetch failed", { cause });

// Engine ADR 0029, N-5: a command prints one line and exits 69.
describe("kit.net.describe", () => {
  it("names the VM's decision for EPERM, EACCES, ECONNRESET and an undeclared network", () => {
    expect(kit.net.describe(netError(new LinuxError(1), "connect", "pypi.org"), "python")).toBe("python: network unavailable: this VM is not connected to the internet");
    expect(kit.net.describe(fetchFailure(netError(new LinuxError(13), "connect", "example.com")))).toBe("network refused: example.com is beyond this module's declared network reach");
    expect(kit.net.describe(netError(new LinuxError(104), "read", "example.com"))).toBe("connection to example.com reset: the VM's internet connection was revoked, or the server reset it");
    expect(kit.net.describe(notDeclared())).toBe("network not declared: add net.vm or net.internet to requires.host");
  });

  it("describes certificate failures, names, timeouts and anything else by its message", () => {
    expect(kit.net.describe(fetchFailure(new TlsError("unknown-issuer", "example.com")))).toBe("TLS: the certificate of example.com is not signed by an authority this VM trusts");
    expect(kit.net.describe(new TlsError("name-mismatch", "example.com"))).toBe("TLS: the certificate of example.com is not valid for this name");
    expect(kit.net.describe(new TlsError("certificate-expired", "a.test"))).toBe("TLS: the certificate of a.test has expired");
    expect(kit.net.describe(new TlsError("peer-misbehaved", "a.test"))).toBe("TLS with a.test failed: peer misbehaved");
    expect(kit.net.describe(new NetError("ENOTFOUND", "x", { hostname: "nope.test" }))).toBe("cannot resolve nope.test");
    expect(kit.net.describe(new DOMException("t", "TimeoutError"))).toBe("network request timed out");
    expect(kit.net.describe(new Error("other"), "tool")).toBe("tool: other");
  });

  it("gives each failure its Linux errno and keeps 69 in the adapter's range", () => {
    expect([kit.net.errno(netError(new LinuxError(1), "connect")), kit.net.errno(new NetError("ECONNREFUSED", "x")), kit.net.errno(new Error("x"))]).toEqual([1, 111, 5]);
    expect(MODULE_EXIT.unavailable).toBe(69);
    expect(MODULE_EXIT.unavailable).toBeLessThanOrEqual(MODULE_EXIT.adapterMax);
  });
});
