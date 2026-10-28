import { createVM, VMError } from "@oxidevm/sdk";
import type { ImageRef, VM } from "@oxidevm/sdk";
import image from "./image.ts";
import productionImage from "./production-image.ts";
import runtime from "./runtime.ts";
import { initialPage } from "./page.ts";
import { decodeAccessLine, startServer, verifyExecutable } from "./server.ts";
import { TerminalView } from "./terminal.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

function element<T extends HTMLElement>(id: string, constructor: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof constructor)) throw new Error(`Missing starter element: ${id}`);
  return value;
}
const toggle = element("toggle", HTMLButtonElement), state = element("state", HTMLElement);
const preview = element("preview", HTMLIFrameElement), progress = element("progress", HTMLElement);
const response = element("response", HTMLOutputElement), failure = element("failure", HTMLElement);
const edit = element("edit", HTMLButtonElement);
const editor = element("editor", HTMLFormElement), html = element("html", HTMLTextAreaElement);
const reset = element("reset", HTMLButtonElement), resetDialog = element("reset-dialog", HTMLDialogElement);
const interrupt = element("interrupt", HTMLButtonElement), focusTerminal = element("focus-terminal", HTMLButtonElement);
const saveStatus = element("save-status", HTMLElement);
let vm: VM | undefined, terminal: TerminalView | undefined;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let opening: AbortController | undefined, changing = false, revision = 0;

function failed(error: unknown): void {
  failure.hidden = false; progress.hidden = true;
  element("error-message", HTMLElement).textContent = error instanceof VMError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "The browser runtime failed.";
}
function starterImage(value: ImageRef<"userspace"> | undefined): ImageRef<"userspace"> {
  if (value === undefined) throw new Error("The signed starter image is unavailable.");
  return value;
}
function showState(value: "opening" | "running" | "stopped"): void {
  state.textContent = value === "running" ? "Running" : value === "opening" ? "Opening Linux…" : "Stopped";
  state.dataset["state"] = value;
  toggle.textContent = value === "running" ? "Stop" : value === "opening" ? "Cancel" : "Start";
  if (value !== "running") delete response.dataset["ok"];
}
function reload(): void {
  if (server === undefined) return;
  const url = new URL("/index.html", server.preview.url);
  url.searchParams.set("revision", String(++revision));
  response.value = "Requesting…"; preview.src = url.href; preview.hidden = false;
}
function log(line: string | null): void {
  if (line === null) { response.value = "Status unavailable"; delete response.dataset["ok"]; return; }
  const access = decodeAccessLine(line);
  if (access !== null && access.path === "/index.html") {
    response.value = `${String(access.status)}${access.status === 200 ? " OK" : ""}`;
    response.dataset["ok"] = String(access.status === 200);
  }
}
async function launch(): Promise<void> {
  if (changing || opening !== undefined) return;
  const current = new AbortController(); opening = current;
  showState("opening"); failure.hidden = true; progress.hidden = false; progress.textContent = "Opening Linux…";
  try {
    if (vm === undefined) {
      const selectedImage = starterImage(import.meta.env.DEV ? image : productionImage);
      const location = new URL(window.location.href);
      location.hostname = "preview.localhost";
      vm = await createVM({ mode: "userspace", image: selectedImage, runtime, workspaceId: "oxidevm-starter-v1", commandInterceptors: "off", network: { mode: "local" }, ...(import.meta.env.DEV && runtime.hosting === "self-hosted" ? { preview: { origin: location.origin, isolation: "per-session" as const } } : {}), signal: current.signal, onProgress: update => { progress.textContent = update.phase === "download" ? `Downloading ${update.asset}…` : "Opening Linux…"; } });
      const executable = await vm.exec({ command: "/bin/head", args: ["-c", "64", "/usr/sbin/nginx"], maxOutputBytes: 4096, signal: current.signal });
      verifyExecutable(executable.stdout);
      element("binary", HTMLElement).textContent = "ELF 64-bit · x86-64";
      const font = await fetch("/fonts/archivo.woff2", { signal: current.signal });
      if (!font.ok) throw new Error("The starter font could not be loaded. Check the local public/fonts directory.");
      const fontBytes = new Uint8Array(await font.arrayBuffer());
      try { await vm.workspace.readText("site/index.html", current.signal); }
      catch (error) {
        if (!(error instanceof VMError) || error.code !== "STORAGE_NOT_FOUND") throw error;
        const directory = await vm.exec({ command: "/bin/mkdir", args: ["-p", "/workspace/site"], signal: current.signal });
        if (directory.exit.kind !== "exited" || directory.exit.code !== 0) throw new Error("The demo directory could not be created.", { cause: error });
        await vm.workspace.writeText("site/index.html", initialPage, current.signal);
      }
      await vm.workspace.writeFile("site/archivo.woff2", fontBytes, current.signal);
      terminal = await TerminalView.open(vm, element("terminal", HTMLElement), failed);
      element("persistence", HTMLElement).textContent = vm.workspace.persistence.kind === "persistent" ? "index.html · Stored in this browser · Best-effort retention" : "Temporary workspace · This browser cannot persist changes";
      edit.disabled = false; reset.disabled = false; interrupt.disabled = false; focusTerminal.disabled = false;
    }
    const session = await startServer(vm, log, current.signal); server = session;
    progress.hidden = true; showState("running"); reload();
    void session.exit.then(() => {
      if (server !== session) return;
      server = undefined; showState("stopped"); preview.hidden = true; preview.removeAttribute("src");
      progress.hidden = false; progress.textContent = "nginx stopped. Choose Start to run it again."; response.value = "No server";
      void session.preview.close().catch(failed);
    }).catch(failed);
  } catch (error) {
    if (!current.signal.aborted) failed(error);
    else { progress.hidden = false; progress.textContent = "Startup canceled. Choose Start to try again."; }
    await terminal?.close().catch(() => undefined); terminal = undefined;
    await vm?.dispose().catch(() => undefined); vm = undefined;
    edit.disabled = true; reset.disabled = true; interrupt.disabled = true; focusTerminal.disabled = true;
    preview.hidden = true; showState("stopped");
  } finally { opening = undefined; }
}
async function stop(): Promise<void> {
  if (opening !== undefined) { opening.abort(); return; }
  if (changing || server === undefined) return;
  changing = true; toggle.disabled = true;
  const current = server; server = undefined;
  try {
    preview.hidden = true; preview.removeAttribute("src");
    await current.stop(); showState("stopped"); response.value = "No server";
    progress.hidden = false; progress.textContent = "nginx stopped. Your files and terminal are still here.";
  } catch (error) { failed(error); showState("stopped"); }
  finally { changing = false; toggle.disabled = false; }
}
toggle.addEventListener("click", () => { if (opening !== undefined || server !== undefined) void stop(); else void launch(); });
edit.addEventListener("click", () => {
  const current = vm; if (current === undefined) return;
  void current.workspace.readText("site/index.html").then(text => { html.value = text; editor.hidden = false; edit.setAttribute("aria-expanded", "true"); html.focus(); }).catch(failed);
});
element("close-editor", HTMLButtonElement).addEventListener("click", () => { editor.hidden = true; edit.setAttribute("aria-expanded", "false"); edit.focus(); });
editor.addEventListener("submit", event => {
  event.preventDefault(); const current = vm; if (current === undefined) return;
  saveStatus.textContent = "Saving…";
  void current.workspace.writeText("site/index.html", html.value).then(() => { saveStatus.textContent = "Saved to workspace"; reload(); }).catch((error: unknown) => { saveStatus.textContent = "Save failed. Your editor text is still here."; failed(error); });
});
reset.addEventListener("click", () => { resetDialog.returnValue = "cancel"; resetDialog.showModal(); });
resetDialog.addEventListener("close", () => {
  if (resetDialog.returnValue !== "reset" || vm === undefined) return;
  void vm.workspace.writeText("site/index.html", initialPage).then(() => { html.value = initialPage; saveStatus.textContent = "Demo page reset"; reload(); }).catch(failed);
});
interrupt.addEventListener("click", () => { void terminal?.handle.interrupt().catch(failed); });
focusTerminal.addEventListener("click", () => { terminal?.focus(); });
window.addEventListener("pagehide", () => { opening?.abort(); void vm?.dispose().catch(() => undefined); });
void launch();
