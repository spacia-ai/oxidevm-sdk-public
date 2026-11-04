import { WASM_TEST_PROPERTIES, type ConsentCard } from "@oxidevm/sdk/image-builder";
import { describe, expect, it } from "vitest";
import { consentText, printable, testText, type ConsentView } from "./wasm-text.js";
import { decodeCliReport } from "./report.js";
import { reportExitCode } from "./run.js";

const CARD: ConsentCard = {
  id: "tool", version: "1.0.0", source: "github:acme/tool@v1.0.0", release: "r".repeat(64), license: { spdx: "MIT", copyleft: false },
  capabilities: ["files.sync"], browser: [], guestExecutables: [], mounts: [], endpoints: [], commands: [], guestFiles: [], network: { reach: "none", hosts: [], children: false }, durablePaths: [], options: [],
  artifacts: [{ name: "tool.wasm", bytes: 1500 }], signals: {}, minApi: 143,
};
function view(overrides: Omit<Partial<ConsentView>, "card"> & { readonly card?: Partial<ConsentCard> } = {}): ConsentView {
  return { status: "added", added: [], removed: [], consent: { reasons: ["untrusted-source"] }, ...overrides, card: { ...CARD, ...overrides.card } };
}
const rows = (text: string): string[] => text.split("\n").filter(line => /^ {2}\S/u.test(line)).map(line => line.trim().split(/\s/u)[0] ?? "");

describe("the consent card", () => {
  it("lists only what the module declares, with no label that has nothing after it", () => {
    const text = consentText(view());
    expect(rows(text)).toEqual(["from", "license", "host", "network", "size"]);
    expect(text).toContain("  network  none: it opens no network connections of its own");
    expect(text).toContain("Add module tool 1.0.0");
    expect(text).toContain("  host     files.sync");
    expect(text).toContain("  size     1 KB in 1 file");
    expect(text).not.toMatch(/^ {2}(?:browser|options|guest|mounts|listens|writes) *$/mu);
  });

  it("adds a row for each kind of declaration that is present", () => {
    const text = consentText(view({ card: {
      browser: ["jspi", "web-locks"], guestExecutables: ["/usr/bin/python3"], mounts: ["/workspace (rw)"], endpoints: ["unix /workspace/_oxidevm/db.sock (oxidevm-sql/1)"],
      guestFiles: ["/workspace/_oxidevm/client.py"], durablePaths: ["/workspace/pgdata"], options: ["dataDir (string)"], capabilities: [],
    } }));
    expect(rows(text)).toEqual(["from", "license", "host", "browser", "guest", "mounts", "network", "listens", "writes", "options", "size"]);
    expect(text).toContain("  host     nothing beyond its own files");
    expect(text).toContain("  browser  jspi, web-locks");
    expect(text).toContain("  writes   /workspace/_oxidevm/client.py\n           /workspace/pgdata (durable)");
  });

  it("says a copyleft license carries obligations and shows what a source proves", () => {
    const text = consentText(view({ card: { license: { spdx: "MPL-2.0", copyleft: true }, signals: { commit: "0123456789abcdef0123", immutable: "yes", attested: "no" } } }));
    expect(text).toContain("MPL-2.0 (copyleft: ship its notices and offer its source)");
    expect(text).toContain("github:acme/tool@v1.0.0 (commit 0123456789ab, immutable release: yes, no attestation)");
  });

  it("never presents an attestation as verified: the tool only learns that GitHub holds one for the release", () => {
    const line = (attested: "yes" | "no" | "unknown"): string => consentText(view({ card: { signals: { commit: "0123456789abcdef0123", immutable: "unknown", attested } } })).split("\n")[1] ?? "";
    expect(line("yes")).toContain("an attestation exists, not verified here");
    expect(line("no")).toContain("no attestation");
    expect(line("unknown")).toContain("attestation unknown");
    for (const attested of ["yes", "no", "unknown"] as const) expect(line(attested)).not.toMatch(/attested|verified by|signed/u);
  });

  it("does not compare a first install with anything, because nothing is installed", () => {
    const text = consentText(view({ added: ["host:files.sync"] }));
    expect(text).not.toContain("Compared with");
    expect(text).not.toContain("+ host:files.sync");
  });

  it("shows what an update adds and removes", () => {
    const text = consentText(view({ status: "updated", added: ["host:sockets.connect", "listen:tcp:5432"], removed: ["host:files.async"] }));
    expect(text).toContain("Update module tool 1.0.0");
    expect(text).toContain("Compared with the installed release:\n  + host:sockets.connect\n  + listen:tcp:5432\n  - host:files.async");
  });

  it("lists a module's commands, says who can run them and what they replace, and warns that interpreters lend programs the module's capabilities", () => {
    const commands = [{ name: "python", path: "/usr/local/bin/python" }, { name: "python3", path: "/usr/local/bin/python3" }];
    const text = consentText(view({ card: { commands } }));
    expect(rows(text)).toEqual(["from", "license", "host", "network", "commands", "size"]);
    expect(text).toContain([
      "  commands python, python3",
      "           Your application turns them on per VM; then any program in the VM can run them as /usr/local/bin/<name>,",
      "           with its own arguments and input, and the module does that work in the VM's module frame, apart from your page.",
      "           /usr/local/bin comes before /usr/bin on PATH: they take the place of image programs with these names,",
      "           including scripts that start with #!/usr/bin/env <name>.",
      "           A module that runs code it is given (an interpreter such as Python) lets those programs use everything",
      "           it declares: its host operations and its network reach. That code runs in the module frame, not in your page.",
      "  size     1 KB in 1 file",
    ].join("\n"));
    expect(consentText(view())).not.toContain("/usr/local/bin");
  });

  it("shows a command an update adds", () => {
    const text = consentText(view({ status: "updated", added: ["command:python3"], card: { commands: [{ name: "python", path: "/usr/local/bin/python" }, { name: "python3", path: "/usr/local/bin/python3" }] } }));
    expect(text).toContain("Compared with the installed release:\n  + command:python3");
  });

  it("does not compare an update that changed no declaration", () => {
    expect(consentText(view({ status: "updated" }))).not.toContain("Compared with");
  });

  it("says a GitHub owner is not trusted, but not for a directory the person named", () => {
    expect(consentText(view())).toContain('Its source is not in "trusted" in oxidevm.modules.json.');
    expect(consentText(view({ consent: { reasons: [] } }))).not.toContain('"trusted"');
    expect(consentText(view({ card: { source: "file:vendor/tool" } }))).not.toContain('"trusted"');
  });

  it("always says where the module runs and that it is not a sandbox for the programs that run it", () => {
    for (const text of [consentText(view()), consentText(view({ card: { source: "file:vendor/tool" }, consent: { reasons: [] } }))]) {
      expect(text).toContain("This is what the module declares. Its code runs with that authority in the VM's module frame, an opaque origin apart from your page; it is not a sandbox for the programs that run it.");
    }
  });
});

describe("text that came from a module, a file or a Wasm binary", () => {
  it("shows control, bidi and zero-width characters as their code points and keeps line breaks and ordinary text", () => {
    expect(printable("a\u001b[2Kb")).toBe("a\\u{1b}[2Kb");
    expect(printable("line\nbreak")).toBe("line\nbreak");
    expect(printable("\u202eevil\u200b \u2028 \u0085 \u007f \ufeff")).toBe("\\u{202e}evil\\u{200b} \\u{2028} \\u{85} \\u{7f} \\u{feff}");
    expect(printable("d\u00e9j\u00e0 \u65e5\u672c\u8a9e \u2014 \ud83d\ude00")).toBe("d\u00e9j\u00e0 \u65e5\u672c\u8a9e \u2014 \ud83d\ude00");
  });

  it("never lets a card line repaint the terminal, whatever the card holds", () => {
    const hostile = "/workspace/ok\u001b[4A\u001b[0J\nhost     nothing beyond its own files";
    const text = consentText(view({ card: { guestFiles: [hostile], endpoints: [hostile], mounts: [hostile], guestExecutables: [hostile], durablePaths: [hostile], options: [hostile], commands: [{ name: hostile, path: hostile }] } }));
    const controls: string[] = [];
    for (const character of text) { const code = character.codePointAt(0) ?? 0; if (code !== 10 && (code < 32 || (code >= 127 && code <= 159))) controls.push(character); }
    expect(controls).toEqual([]);
    expect(text).toContain("\\u{1b}[4A");
    // A line break inside one value is shown as such, so it cannot start a row of its own.
    expect(text.split("\n").some(line => line.startsWith("host "))).toBe(false);
  });
});

describe("the wasm test report", () => {
  it("lists every property with its status and message and sums up the failures", () => {
    const text = testText({
      schemaVersion: 1, result: "failed", module: { id: "kv", version: "1.0.0", kind: "service", release: "0123456789abcdef" }, sdkVersion: "0.0.8", engineRelease: "sha256:e",
      browser: { name: "chromium", version: "140.0" }, image: { manifestSHA256: "d" },
      properties: [
        { property: "integrity", status: "passed", elapsedMs: 3 },
        { property: "exit-range", status: "not-applicable", message: "a service is stopped, not run to completion", elapsedMs: 0 },
        { property: "eof-stop", status: "failed", message: "it did not exit within 20 s of end of input and was killed", elapsedMs: 20_000 },
      ],
    });
    expect(text).toBe("kv 1.0.0 (service, release 0123456789ab) in chromium 140.0\nok    integrity\nn/a   exit-range: a service is stopped, not run to completion\nFAIL  eof-stop: it did not exit within 20 s of end of input and was killed\n1 property failed.\n");
  });
});

describe("the wasm test outcomes and their exit statuses", () => {
  const base = { schemaVersion: 1, module: { id: "tool", version: "1.0.0", kind: "command", release: "0123456789abcdef" }, sdkVersion: "0.0.13", engineRelease: "sha256:e", browser: { name: "webkit", version: "26.0" }, image: { manifestSHA256: "d" } } as const;
  const all = (status: string, message?: string) => WASM_TEST_PROPERTIES.map(property => ({ property, status, elapsedMs: 0, ...(message === undefined ? {} : { message }) }));
  const envelope = (result: unknown) => decodeCliReport({ schemaVersion: 3, kind: "result", command: "wasm test", result });

  it("exits 0 when every applicable property passed", () => {
    const report = envelope({ ...base, result: "passed", properties: all("passed") });
    expect(reportExitCode(report)).toBe(0);
  });

  it("exits 3 when a property failed", () => {
    const report = envelope({ ...base, result: "failed", properties: all("failed", "it broke") });
    expect(reportExitCode(report)).toBe(3);
  });

  it("exits 4 and says why, with the reason and capability, when the browser refused the module", () => {
    const refusal = { code: "FEATURE_NOT_AVAILABLE", reason: "wasm-module-isolation-unavailable", capability: "blob-workers", message: "Modules cannot run in this browser: it cannot start a worker from a blob: URL" };
    const report = envelope({ ...base, result: "refused", refusal, properties: all("not-applicable", "not run: the browser refused the module (wasm-module-isolation-unavailable, blob-workers)") });
    expect(reportExitCode(report)).toBe(4);
    if (report.kind !== "result" || report.command !== "wasm test") throw new Error("not a wasm test report");
    expect(testText(report.result)).toBe("tool 1.0.0 (command, release 0123456789ab) in webkit 26.0\nREFUSED wasm-module-isolation-unavailable, capability blob-workers: Modules cannot run in this browser: it cannot start a worker from a blob: URL\nNo property ran: this browser or image cannot run the module.\n");
    const missing = { ...report.result, refusal: { code: "FEATURE_NOT_AVAILABLE", reason: "wasm-module-prerequisite", missing: ["browser feature jspi", "guest executable /usr/bin/python3"], message: "tool did not start" } } as const;
    expect(testText(missing)).toContain("REFUSED wasm-module-prerequisite, missing browser feature jspi, guest executable /usr/bin/python3: tool did not start\n");
  });
});

describe("the network row (engine ADR 0029)", () => {
  it("says the reach, the disclosed hosts and purpose, and that programs the module starts follow the VM", () => {
    expect(consentText(view({ card: { network: { reach: "vm", hosts: [], children: false } } }))).toContain("  network  this VM only: programs in the VM, not the internet\n");
    const text = consentText(view({ card: { capabilities: ["net.internet", "process.spawn"], network: { reach: "internet", hosts: ["*.pythonhosted.org", "pypi.org"], purpose: "Python programs reach the internet through the VM", children: true } } }));
    expect(text).toContain([
      "  network  the internet, through the VM's connection (TCP 80 and 443, and DNS), once your application connects the VM and the user allows it",
      "           contacts by default: *.pythonhosted.org, pypi.org (disclosed by the module, not enforced)",
      "           purpose: Python programs reach the internet through the VM",
      "           programs it starts follow the VM's own network policy, not this reach",
    ].join("\n"));
  });

  it("escapes what a module discloses, so a host or purpose cannot start a line of its own", () => {
    const text = consentText(view({ card: { network: { reach: "internet", hosts: ["a.com"], purpose: "x\nnetwork  none", children: false } } }));
    expect(text).toContain("purpose: x\\u{a}network  none");
  });
});
