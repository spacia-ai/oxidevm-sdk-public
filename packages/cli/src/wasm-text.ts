import type { AddPreview, ConsentCard, WasmAddResult, WasmBuildFinding, WasmBuildResult, WasmDoctorReport, WasmInspectResult, WasmStageResult, WasmTestReport } from "@oxidevm/sdk/image-builder";
import type { WasmInitResult, WasmReleaseResult } from "./contracts.js";

const megabytes = (bytes: number): string => bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
/** A labelled block of lines; a label with nothing to say is left out. */
const row = (label: string, values: readonly string[]): string[] => {
  const present = values.filter(value => value !== "");
  return present.length === 0 ? [] : [`  ${label.padEnd(9)}${present[0] ?? ""}`, ...present.slice(1).map(value => `  ${" ".repeat(9)}${value}`)];
};

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const spell = (character: string): string => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;
/**
 * Escapes what a terminal acts on or a reader cannot see (control, bidi, zero-width and separator characters) as its code
 * point, and keeps line breaks. For whole outputs that may hold text from a module, a file or a Wasm binary.
 */
export const printable = (text: string): string => text.replace(INVISIBLE, character => character === "\n" ? character : spell(character));
/** The same escaping for one value placed inside a line, line breaks included, so a value cannot start a line of its own. */
export const field = (text: string): string => text.replace(INVISIBLE, spell);

const safeCard = (card: ConsentCard): ConsentCard => ({
  ...card, id: field(card.id), version: field(card.version), source: field(card.source), license: { ...card.license, spdx: field(card.license.spdx) },
  browser: card.browser.map(field), guestExecutables: card.guestExecutables.map(field), mounts: card.mounts.map(field), endpoints: card.endpoints.map(field),
  guestFiles: card.guestFiles.map(field), durablePaths: card.durablePaths.map(field), options: card.options.map(field), capabilities: card.capabilities.map(field),
});

/** What the card needs of a preview: the release's declarations and how it differs from what is installed. */
export type ConsentView = Pick<AddPreview, "card" | "status" | "added" | "removed"> & { readonly consent: Pick<AddPreview["consent"], "reasons"> };

/** GitHub only says whether it holds an attestation for the release; this tool does not verify one, and must not read as if it did. */
function attestationText(attested: "yes" | "no" | "unknown"): string {
  return attested === "yes" ? "an attestation exists, not verified here" : attested === "no" ? "no attestation" : "attestation unknown";
}

/** What the person is asked to accept, as plain lines. The wording says "declares": a module is code, not a sandbox. */
export function consentText(preview: ConsentView): string {
  const card = safeCard(preview.card);
  const signals = [card.signals.commit === undefined ? undefined : `commit ${card.signals.commit.slice(0, 12)}`, card.signals.immutable === undefined ? undefined : `immutable release: ${card.signals.immutable}`, card.signals.attested === undefined ? undefined : attestationText(card.signals.attested)].filter((item): item is string => item !== undefined);
  const lines = [
    `${preview.status === "added" ? "Add" : "Update"} module ${card.id} ${card.version}`,
    ...row("from", [`${card.source}${signals.length === 0 ? "" : ` (${signals.join(", ")})`}`]),
    ...row("license", [`${card.license.spdx}${card.license.copyleft ? " (copyleft: ship its notices and offer its source)" : ""}`]),
    ...row("host", [card.capabilities.join(", ") || "nothing beyond its own files"]),
    ...row("browser", [card.browser.join(", ")]),
    ...row("guest", card.guestExecutables),
    ...row("mounts", card.mounts),
    ...row("listens", card.endpoints),
    ...row("writes", [...card.guestFiles, ...card.durablePaths.map(path => `${path} (durable)`)]),
    ...row("options", [card.options.join(", ")]),
    ...row("size", [`${megabytes(card.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0))} in ${String(card.artifacts.length)} file${card.artifacts.length === 1 ? "" : "s"}`]),
  ];
  // A first install has nothing installed to compare with: the rows above are everything it asks for.
  if (preview.status === "updated" && (preview.added.length > 0 || preview.removed.length > 0)) lines.push("", "Compared with the installed release:", ...preview.added.map(item => `  + ${field(item)}`), ...preview.removed.map(item => `  - ${field(item)}`));
  lines.push("", "This is what the module declares. Its code runs in a worker of your page with that authority; it is not sandboxed from your application.");
  // A directory in the project was chosen by the person running the command; "trusted" lists GitHub owners.
  if (preview.consent.reasons.includes("untrusted-source") && card.source.startsWith("github:")) lines.push(`Its source is not in "trusted" in oxidevm.modules.json.`);
  return `${lines.join("\n")}\n`;
}

export function addText(result: WasmAddResult): string {
  if (result.status === "unchanged") return `${result.id} ${result.version} is already installed and up to date.\n`;
  return `${result.status === "added" ? "Added" : "Updated"} ${result.id} ${result.version} from ${result.source}. Import it from ${result.generatedFile}:\n  import { ${result.id.replace(/-([a-z0-9])/gu, (_match, character: string) => character.toUpperCase())} } from "./${result.generatedFile.replace(/^src\//u, "").replace(/\.ts$/u, "")}";\n`;
}

export function stageText(result: WasmStageResult): string {
  if (result.modules.length === 0) return `No modules are installed. Wrote ${result.generatedFile}.\n`;
  const rebuilt = result.modules.filter(module => module.rebuilt).length;
  return `Staged ${String(result.modules.length)} module${result.modules.length === 1 ? "" : "s"} (${String(rebuilt)} rebuilt) and wrote ${result.generatedFile}.\n`;
}

export function doctorText(report: WasmDoctorReport): string {
  const lines = report.checks.map(entry => `${entry.status === "passed" ? "ok    " : entry.status === "note" ? "note  " : "FAIL  "}${entry.check}${entry.status === "passed" ? "" : `: ${entry.message}`}`);
  return `${lines.join("\n")}\n${report.result === "passed" ? "All checks passed." : "Some checks failed."}\n`;
}

export function inspectText(result: WasmInspectResult): string {
  const lines = [
    `${result.file}: ${result.kind === "component" ? "component" : "core module"}, ${megabytes(result.bytes)}`,
    `  abi      ${result.abi} (${result.evidence.join("; ")})`,
    `  imports  ${result.imports.map(item => `${item.module} (${String(item.names)})`).join(", ") || "none"}`,
    `  exports  ${String(result.exports.length)}${result.exports.length === 0 ? "" : `, e.g. ${result.exports.slice(0, 5).join(", ")}`}`,
    `  memory   ${result.memories.map(memory => `${String(memory.minPages)}${memory.maxPages === null ? "+" : `-${String(memory.maxPages)}`} pages${memory.shared ? " shared" : ""}${memory.memory64 ? " 64-bit" : ""}`).join(", ") || "imported or none defined"}`,
    `  sections ${result.customSections.join(", ") || "none"}${result.targetFeatures ? "" : " (no target_features: declare requires.browser features yourself)"}`,
  ];
  return `${lines.join("\n")}\n`;
}

const placeOf = (item: WasmBuildFinding): string => item.file === undefined ? "" : `${item.file}${item.line === undefined ? "" : `:${String(item.line)}${item.column === undefined ? "" : `:${String(item.column)}`}`}  `;
const findingLine = (item: WasmBuildFinding): string => `${item.severity === "error" ? "error  " : "warning"} ${placeOf(item)}${item.message} [${item.code}]`;

export function buildText(result: WasmBuildResult): string {
  const findings = result.findings.map(findingLine);
  if (result.result === "failed") {
    const errors = result.findings.filter(item => item.severity === "error").length;
    return `${findings.join("\n")}\nThe build failed with ${String(errors)} error${errors === 1 ? "" : "s"}; nothing was written.\n`;
  }
  const head = result.result === "built" ? `Built ${result.id ?? ""} ${result.version ?? ""} into ${result.directory ?? ""}.` : `Checked ${result.id ?? ""} ${result.version ?? ""}: it builds, and nothing was written.`;
  const lines = [...findings, head, ...row("release", result.release === null ? [] : [result.release]), ...row("files", result.files.map(file => `${file.name} (${megabytes(file.bytes)})`)), ...row("bundles", result.bundled.map(entry => `${entry.name}@${entry.version} (${entry.license})`))];
  return `${lines.join("\n")}\n`;
}

export function releaseText(result: WasmReleaseResult): string {
  if (result.tag === null) return buildText(result.build);
  return `${buildText(result.build)}\nTo publish ${result.tag} (none of this has been run):\n\n${result.steps.join("\n\n")}\n`;
}

export function initText(result: WasmInitResult): string {
  return `Created ${result.directory}: a ${result.kind} module named ${result.id} (abi ${result.abi}), ${String(result.files.length)} files.\n\nNext:\n  cd ${result.directory}\n  pnpm install\n  pnpm run check && pnpm test\n  pnpm run build\n`;
}

export function testText(report: WasmTestReport): string {
  const lines = report.properties.map(entry => `${entry.status === "passed" ? "ok    " : entry.status === "failed" ? "FAIL  " : "n/a   "}${entry.property}${entry.message === undefined ? "" : `: ${entry.message}`}`);
  const failed = report.properties.filter(entry => entry.status === "failed").length;
  return `${report.module.id} ${report.module.version} (${report.module.kind}, release ${report.module.release.slice(0, 12)}) in ${report.browser.name} ${report.browser.version}\n${lines.join("\n")}\n${failed === 0 ? "All applicable properties passed." : `${String(failed)} propert${failed === 1 ? "y" : "ies"} failed.`}\n`;
}
