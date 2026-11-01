import type { ConsentCard } from "@oxidevm/sdk/image-builder";
import { describe, expect, it } from "vitest";
import { consentText, printable, type ConsentView } from "./wasm-text.js";

const CARD: ConsentCard = {
  id: "tool", version: "1.0.0", source: "github:acme/tool@v1.0.0", release: "r".repeat(64), license: { spdx: "MIT", copyleft: false },
  capabilities: ["files.sync"], browser: [], guestExecutables: [], mounts: [], endpoints: [], guestFiles: [], durablePaths: [], options: [],
  artifacts: [{ name: "tool.wasm", bytes: 1500 }], signals: {}, minApi: 143,
};
function view(overrides: Omit<Partial<ConsentView>, "card"> & { readonly card?: Partial<ConsentCard> } = {}): ConsentView {
  return { status: "added", added: [], removed: [], consent: { reasons: ["untrusted-source"] }, ...overrides, card: { ...CARD, ...overrides.card } };
}
const rows = (text: string): string[] => text.split("\n").filter(line => /^ {2}\S/u.test(line)).map(line => line.trim().split(/\s{2,}/u)[0] ?? "");

describe("the consent card", () => {
  it("lists only what the module declares, with no label that has nothing after it", () => {
    const text = consentText(view());
    expect(rows(text)).toEqual(["from", "license", "host", "size"]);
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
    expect(rows(text)).toEqual(["from", "license", "host", "browser", "guest", "mounts", "listens", "writes", "options", "size"]);
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

  it("does not compare an update that changed no declaration", () => {
    expect(consentText(view({ status: "updated" }))).not.toContain("Compared with");
  });

  it("says a GitHub owner is not trusted, but not for a directory the person named", () => {
    expect(consentText(view())).toContain('Its source is not in "trusted" in oxidevm.modules.json.');
    expect(consentText(view({ consent: { reasons: [] } }))).not.toContain('"trusted"');
    expect(consentText(view({ card: { source: "file:vendor/tool" } }))).not.toContain('"trusted"');
  });

  it("always says that the module is not sandboxed", () => {
    for (const text of [consentText(view()), consentText(view({ card: { source: "file:vendor/tool" }, consent: { reasons: [] } }))]) {
      expect(text).toContain("This is what the module declares. Its code runs in a worker of your page with that authority; it is not sandboxed from your application.");
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
    const text = consentText(view({ card: { guestFiles: [hostile], endpoints: [hostile], mounts: [hostile], guestExecutables: [hostile], durablePaths: [hostile], options: [hostile] } }));
    const controls: string[] = [];
    for (const character of text) { const code = character.codePointAt(0) ?? 0; if (code !== 10 && (code < 32 || (code >= 127 && code <= 159))) controls.push(character); }
    expect(controls).toEqual([]);
    expect(text).toContain("\\u{1b}[4A");
    // A line break inside one value is shown as such, so it cannot start a row of its own.
    expect(text.split("\n").some(line => line.startsWith("host "))).toBe(false);
  });
});
