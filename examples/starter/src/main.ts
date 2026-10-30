import { createVM, VMError } from "@oxidevm/sdk";
import type { ImageRef, VM } from "@oxidevm/sdk";
import image from "./image.js";
import productionImage from "./production-image.js";
import runtime from "./runtime.js";
import { sampleCode, sampleCsv, uploadedCode } from "./analysis.js";
import { maxUploadBytes, uploadError } from "./dataframe.js";
import type { Dataframe } from "./dataframe.js";
import { PythonSession, verifyPython } from "./python.js";
import { pythonEditor } from "./editor.js";
import { TerminalView } from "./terminal.js";
import { mountAgentSkills } from "./agent-skills.js";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

mountAgentSkills();

function element<T extends HTMLElement>(id: string, constructor: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof constructor)) throw new Error(`Missing starter element: ${id}`);
  return value;
}
const code = element("code", HTMLTextAreaElement), run = element("run", HTMLButtonElement);
const cancel = element("cancel", HTMLButtonElement), upload = element("upload", HTMLButtonElement);
const file = element("file", HTMLInputElement), exportCSV = element("export", HTMLButtonElement);
const reset = element("reset", HTMLButtonElement), state = element("state", HTMLElement);
const progress = element("progress", HTMLElement), error = element("error", HTMLElement);
const interrupt = element("interrupt", HTMLButtonElement), focus = element("focus-terminal", HTMLButtonElement);
let vm: VM | undefined, terminal: TerminalView | undefined, running: AbortController | undefined;
let python: PythonSession | undefined;
let busy = true, csvPath: string | undefined, sourceName = "sample CSV", datasetGeneration = 0, resultGeneration = -1;
const lifetime = new AbortController();
const setCode = pythonEditor(code, element("code-highlight", HTMLPreElement), lifetime.signal);
setCode(sampleCode);

function requiredImage(value: ImageRef<"userspace"> | undefined): ImageRef<"userspace"> {
  if (value === undefined) throw new VMError("INVALID_ARGUMENT", "The signed Python image is unavailable. Configure src/image.ts before starting Linux.");
  return value;
}
function message(value: unknown): string { return value instanceof Error ? value.message : "The operation failed."; }
function failed(value: unknown): void {
  error.hidden = false;
  element("error-message", HTMLElement).textContent = message(value);
  const shape = element("shape", HTMLOutputElement);
  if (csvPath !== undefined && !shape.textContent.endsWith("Previous result")) shape.textContent += " · Previous result";
}
function controls(value: boolean): void {
  busy = value; run.disabled = value || vm === undefined; upload.disabled = value || vm === undefined; reset.disabled = value || vm === undefined;
  exportCSV.disabled = value || csvPath === undefined || resultGeneration !== datasetGeneration;
  state.dataset["state"] = value ? "busy" : "running";
  state.textContent = value ? running === undefined ? "Opening Linux…" : "Running Python…" : "Ready";
}
function render(frame: Dataframe): void {
  const head = element("columns", HTMLTableSectionElement), body = element("rows", HTMLTableSectionElement);
  const row = document.createElement("tr"), corner = document.createElement("th"); corner.scope = "col"; corner.textContent = "#"; row.append(corner);
  for (const column of frame.columns) {
    const th = document.createElement("th"); th.scope = "col";
    const label = document.createElement("span"), type = document.createElement("small"); label.textContent = column.name; type.textContent = column.dtype; th.append(label, type); row.append(th);
  }
  head.replaceChildren(row); body.replaceChildren();
  frame.rows.forEach((cells, index) => {
    const tr = document.createElement("tr"), label = document.createElement("th"); label.scope = "row"; label.textContent = frame.index[index] ?? ""; tr.append(label);
    for (const value of cells) { const td = document.createElement("td"); td.textContent = value === null ? "null" : String(value); td.dataset["numeric"] = String(typeof value === "number"); tr.append(td); }
    body.append(tr);
  });
  element("table-scroll", HTMLElement).hidden = false; progress.hidden = true;
  element("shape", HTMLOutputElement).textContent = `${frame.rowCount.toLocaleString()} rows · ${String(frame.columns.length)} columns${frame.rowCount > frame.rows.length ? ` · Showing first ${String(frame.rows.length)}` : ""}${frame.csvAvailable ? "" : " · CSV exceeds 10 MiB export limit"}`;
  element("dataset", HTMLElement).textContent = `From ${sourceName}`;
  element("binary", HTMLElement).textContent = `Real Linux executable · x86-64 · Python ${frame.versions.python} · pandas ${frame.versions.pandas}`;
}
async function execute(): Promise<void> {
  if (busy || vm === undefined || python === undefined) return;
  const current = new AbortController(); running = current; error.hidden = true; cancel.hidden = false; controls(true);
  progress.textContent = "Running Python and pandas in Linux…";
  const timeout = setTimeout(() => { current.abort(new Error("Python exceeded the three-minute run limit. Reduce the workload and try again.")); }, 180000);
  try {
    const result = await python.run(code.value, current.signal);
    const previous = csvPath;
    csvPath = result.frame.csvAvailable ? result.csvPath : undefined; resultGeneration = datasetGeneration; render(result.frame);
    if (previous !== undefined) await vm.workspace.remove(previous).catch(() => undefined);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    element("output", HTMLElement).textContent = output; element("output-panel", HTMLDetailsElement).hidden = output === "";
  } catch (value) { failed(current.signal.aborted ? current.signal.reason : value); }
  finally { clearTimeout(timeout); running = undefined; cancel.hidden = true; controls(false); }
}
async function mkdir(directory: string): Promise<void> {
  if (vm === undefined) throw new Error("Linux is not ready.");
  const result = await vm.exec({ command: "/bin/mkdir", args: ["-p", directory], signal: lifetime.signal });
  if (result.exit.kind !== "exited" || result.exit.code !== 0) throw new Error("The Linux workspace could not be prepared.");
}
async function showCSV(): Promise<void> {
  if (vm === undefined) return;
  const csv = await vm.workspace.read("data.csv", { maxBytes: maxUploadBytes, signal: lifetime.signal });
  element("csv-source", HTMLElement).textContent = new TextDecoder().decode(csv.data).slice(0, 65536);
}
async function uploadCSV(selected: File): Promise<void> {
  const validation = uploadError(selected); if (validation !== undefined) { failed(new Error(validation)); return; }
  if (busy || vm === undefined || python === undefined) return;
  controls(true); error.hidden = true;
  try {
    const bytes = new Uint8Array(await selected.arrayBuffer()); if (bytes.length > maxUploadBytes) throw new Error("Choose a CSV no larger than 5 MiB.");
    const staged = `uploads/${crypto.randomUUID()}.csv`;
    await vm.workspace.writeFile(staged, bytes, lifetime.signal);
    const copied = await vm.exec({ command: "/bin/cp", args: [`/workspace/${staged}`, "/workspace/_oxidevm/data.next.csv"], signal: lifetime.signal });
    if (copied.exit.kind !== "exited" || copied.exit.code !== 0) throw new Error("The CSV could not be saved. Your previous dataset is preserved.");
    const moved = await vm.exec({ command: "/bin/mv", args: ["/workspace/_oxidevm/data.next.csv", "/workspace/data.csv"], signal: lifetime.signal });
    if (moved.exit.kind !== "exited" || moved.exit.code !== 0) throw new Error("The CSV could not be selected. Its original upload remains in uploads/.");
    sourceName = selected.name.slice(0, 255); datasetGeneration += 1;
    if (code.value === sampleCode || code.value === uploadedCode) setCode(uploadedCode);
    await vm.workspace.writeText("analysis.py", code.value, lifetime.signal);
    await vm.workspace.writeText("dataset.json", JSON.stringify({ name: sourceName }), lifetime.signal);
    await showCSV();
  } catch (value) { failed(value); return; }
  finally { controls(false); file.value = ""; }
  await execute();
}
async function open(): Promise<void> {
  try {
    const selected = requiredImage(import.meta.env.DEV ? image : productionImage);
    vm = await createVM({ mode: "userspace", image: selected, runtime, memoryMiB: 1536, workspaceId: "oxidevm-pandas-starter-v1", commandInterceptors: "off", network: { mode: "local" }, signal: lifetime.signal, onProgress: update => { progress.textContent = update.phase === "download" ? `Downloading ${update.asset}…` : "Opening Linux Python…"; } });
    const binary = await vm.exec({ command: "/bin/head", args: ["-c", "64", "/usr/bin/python3"], maxOutputBytes: 4096, signal: lifetime.signal }); verifyPython(binary.stdout);
    element("binary", HTMLElement).textContent = "Real Linux executable · x86-64";
    await mkdir("/workspace/_oxidevm"); await mkdir("/workspace/uploads");
    try { setCode(await vm.workspace.readText("analysis.py", lifetime.signal)); }
    catch (value) { if (!(value instanceof VMError) || value.code !== "STORAGE_NOT_FOUND") throw value; await vm.workspace.writeText("analysis.py", sampleCode, lifetime.signal); await vm.workspace.writeText("data.csv", sampleCsv, lifetime.signal); }
    try { const metadata: unknown = JSON.parse(await vm.workspace.readText("dataset.json", lifetime.signal)); if (typeof metadata === "object" && metadata !== null && "name" in metadata && typeof metadata.name === "string" && metadata.name.length <= 255) sourceName = metadata.name; }
    catch (value) { if (!(value instanceof VMError) || value.code !== "STORAGE_NOT_FOUND") throw value; }
    python = new PythonSession(vm);
    terminal = await TerminalView.open(vm, element("terminal", HTMLElement), failed);
    interrupt.disabled = false; focus.disabled = false;
    element("persistence", HTMLElement).textContent = vm.workspace.persistence.kind === "persistent" ? "Workspace stored in this browser" : "Temporary workspace · Browser storage unavailable";
    await showCSV(); controls(false); await execute();
  } catch (value) { progress.hidden = true; failed(value); controls(true); state.textContent = "Could not start"; }
}
run.addEventListener("click", () => { void execute(); });
cancel.addEventListener("click", () => { running?.abort(new Error("Python execution stopped. Your previous result is preserved.")); });
upload.addEventListener("click", () => { file.click(); });
file.addEventListener("change", () => { const selected = file.files?.[0]; if (selected !== undefined) void uploadCSV(selected); });
code.addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void execute(); } });
interrupt.addEventListener("click", () => { void terminal?.handle.interrupt().catch(failed); });
focus.addEventListener("click", () => { terminal?.focus(); });
for (const id of ["code-tab", "csv-tab"]) {
  const tab = element(id, HTMLButtonElement);
  const select = () => { for (const name of ["code", "csv"]) { const active = id === `${name}-tab`, button = element(`${name}-tab`, HTMLButtonElement); button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1; element(`${name}-panel`, HTMLElement).hidden = !active; } };
  tab.addEventListener("click", select);
  tab.addEventListener("keydown", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const target = element(event.key === "Home" ? "code-tab" : event.key === "End" ? "csv-tab" : id === "code-tab" ? "csv-tab" : "code-tab", HTMLButtonElement); target.click(); target.focus(); } });
}
exportCSV.addEventListener("click", () => {
  if (vm === undefined || csvPath === undefined || resultGeneration !== datasetGeneration) return;
  void vm.workspace.read(csvPath, { maxBytes: 10 * 1024 ** 2, signal: lifetime.signal }).then(result => { const bytes = new Uint8Array(result.data); const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = "result.csv"; link.click(); setTimeout(() => { URL.revokeObjectURL(url); }, 1000); }).catch(failed);
});
const dialog = element("reset-dialog", HTMLDialogElement);
reset.addEventListener("click", () => { dialog.returnValue = "cancel"; dialog.showModal(); });
dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "reset" || busy || vm === undefined) return;
  const current = vm; controls(true);
  void (async () => { try { await python?.dispose(); await current.workspace.writeText("data.csv", sampleCsv, lifetime.signal); await current.workspace.writeText("analysis.py", sampleCode, lifetime.signal); await current.workspace.writeText("dataset.json", JSON.stringify({ name: "sample CSV" }), lifetime.signal); setCode(sampleCode); sourceName = "sample CSV"; datasetGeneration += 1; await showCSV(); } catch (value) { failed(value); } finally { controls(false); } await execute(); })();
});
window.addEventListener("pagehide", () => { lifetime.abort(); running?.abort(); void python?.dispose(); void terminal?.close().catch(() => undefined); void vm?.dispose().catch(() => undefined); });
void open();
