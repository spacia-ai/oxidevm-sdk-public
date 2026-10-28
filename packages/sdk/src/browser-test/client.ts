import { createVM, VMError } from "../index.js";
import type { VM, TerminalHandle } from "../index.js";
import { record, string } from "../runtime/decode.js";
import { detectBrowserSupport } from "../runtime/browser-support.js";
import { decodeImageSmokeTest } from "../image-smoke.js";
import { decodeImageCheckResult, IMAGE_TEST_CHECKS } from "../image-builder/reports.js";
import type { ImageCheckResult, ImageTestCheck } from "../image-builder/contracts.js";
import { imageTestVMOptions } from "./image-test-vm.js";

const output = document.createElement("pre"); output.id = "oxidevm-qualification"; document.body.append(output);
const checks = new Map<ImageTestCheck, ImageCheckResult>();
let vm: VM | undefined;
let current: ImageTestCheck = "browser-features";
const signal = AbortSignal.timeout(900_000);
function passed(check: ImageTestCheck): void { checks.set(check, { check, status: "passed" }); }
function explanation(error: unknown): string {
  if (error instanceof VMError) return `${error.code}: ${error.message}; ${JSON.stringify(error.detail)}`.slice(0, 8192);
  return error instanceof Error ? error.message.slice(0, 8192) : "browser operation failed";
}

async function run(): Promise<void> {
  const configURL = new URL(import.meta.url).searchParams.get("config") ?? "/fixture.json";
  const response = await fetch(configURL, { signal });
  if (!response.ok) throw new VMError("PROTOCOL_ERROR", "image-test configuration is unavailable");
  const value: unknown = await response.json(); const config = record(value, "image-test configuration");
  const location = record(config["image"], "image location"); const trust = record(location["trust"], "image trust");
  if (trust["algorithm"] !== "Ed25519") throw new VMError("PROTOCOL_ERROR", "image-test trust is invalid");
  const properties = { manifestUrl: string(location["manifestUrl"], "manifest URL"), manifestSHA256: string(location["manifestSHA256"], "manifest digest"), trust: { algorithm: "Ed25519" as const, keyId: string(trust["keyId"], "key ID"), publicKey: string(trust["publicKey"], "public key") } };
  const mode = location["mode"];
  if (mode !== "system" && mode !== "userspace") throw new VMError("PROTOCOL_ERROR", "invalid image-test mode");
  const smoke = decodeImageSmokeTest(config["smokeTest"]);
  if (!detectBrowserSupport().supported || typeof Worker !== "function" || !globalThis.isSecureContext) throw new VMError("FEATURE_NOT_AVAILABLE", "browser lacks a required execution feature");
  passed("browser-features");
  const workspaceId = `image_test_${crypto.randomUUID()}`;
  const open = () => createVM(imageTestVMOptions(mode, properties, workspaceId, signal));
  current = "runtime-ready"; vm = await open(); passed(current); passed("asset-integrity"); passed("manifest-signature");
  checks.set("preview", { check: "preview", status: "not-applicable", reason: "not-declared" });
  for (const key of ["license-evidence", "reproducible-build"] as const) {
    const decoded = decodeImageCheckResult(config[key]);
    if (decoded.check !== key) throw new Error("evidence check identity is inconsistent");
    checks.set(key, decoded);
  }
  current = "workspace-read-write";
  const expected = Uint8Array.of(0, 255, 128, 1, 10);
  await vm.workspace.writeFile("qualification.bin", expected, signal);
  const bytes = await vm.workspace.readFile("qualification.bin", signal);
  if (bytes.length !== expected.length || bytes.some((byte, index) => byte !== expected[index])) throw new Error("binary workspace roundtrip differs");
  await vm.workspace.writeText("qualification.txt", "OxideVM ☃\n", signal);
  if (await vm.workspace.readText("qualification.txt", signal) !== "OxideVM ☃\n") throw new Error("UTF-8 workspace roundtrip differs");
  if (!(await vm.workspace.list("/", signal)).some(entry => entry.name === "qualification.bin")) throw new Error("workspace listing omitted the committed file");
  passed(current);
  current = "smoke-command";
  const result = await vm.exec({ command: smoke.command, ...(smoke.args === undefined ? {} : { args: smoke.args }), ...(smoke.cwd === undefined ? {} : { cwd: smoke.cwd }), signal });
  if (result.exit.kind !== "exited" || result.exit.code !== smoke.expectedExitCode || smoke.stdoutIncludes !== undefined && !new TextDecoder().decode(result.stdout).includes(smoke.stdoutIncludes)) throw new Error("the authenticated smoke command failed its output or exit expectation");
  passed(current);
  current = "terminal-interrupt";
  if (smoke.command === "/bin/sh") {
    try { await terminalScenario(vm); passed(current); }
    catch (error) { checks.set(current, { check: current, status: "failed", message: explanation(error) }); }
  }
  else checks.set(current, { check: current, status: "not-applicable", reason: "not-declared" });
  current = "persistence-reopen";
  await vm.dispose(); vm = undefined;
  vm = await open();
  if (await vm.workspace.readText("qualification.txt", signal) !== "OxideVM ☃\n") throw new Error("reopened workspace lost committed text");
  const reopened = await vm.workspace.readFile("qualification.bin", signal);
  if (reopened.length !== expected.length || reopened.some((byte, index) => byte !== expected[index])) throw new Error("reopened workspace lost committed binary bytes");
  await vm.workspace.remove("qualification.txt", { signal }); await vm.workspace.remove("qualification.bin", { signal });
  passed(current);
}

async function terminalScenario(owner: VM): Promise<void> {
  const marker = crypto.randomUUID().replaceAll("-", ""); const prompt = `oxidevm_${marker}$ `;
  const terminal = await owner.spawn({ command: "/bin/sh", args: ["-i"], terminal: { columns: 80, rows: 24 }, env: { PS1: prompt, TERM: "xterm" }, signal });
  const writer = terminal.stdin.getWriter(); const reader = terminal.output.getReader();
  let screen = ""; let fault: unknown; let stopped = false;
  const decoder = new TextDecoder();
  const draining = (async () => {
    try {
      for (;;) { const next = await reader.read(); if (next.done) { stopped = true; return; } screen = (screen + decoder.decode(next.value, { stream: true })).slice(-65536); }
    } catch (error) { fault = error; } finally { reader.releaseLock(); }
  })();
  try {
    await until("shell prompt", () => screen.includes(prompt), () => fault, () => stopped);
    await terminal.resize({ columns: 132, rows: 43 });
    await writer.write(new TextEncoder().encode(`stty size; printf 'size_${marker}\\n'\n`));
    await until("native resize", () => screen.includes("43 132") && screen.includes(`size_${marker}\r\n`), () => fault, () => stopped);
    screen = "";
    await writer.write(new TextEncoder().encode(`/bin/sh -c "printf 'ready_${marker}\\n'; exec sleep 60"\n`));
    await until("foreground child ready", () => screen.includes(`ready_${marker}\r\n`), () => fault, () => stopped);
    await terminal.interrupt();
    await until("prompt after foreground interrupt", () => screen.includes(prompt), () => fault, () => stopped);
    await writer.write(new TextEncoder().encode(`printf 'usable_${marker}\\n'\n`));
    await until("shell usable after interrupt", () => screen.includes(`usable_${marker}\r\n`), () => fault, () => stopped);
  } catch (error) {
    throw new Error(`${explanation(error)}; terminal output: ${JSON.stringify(screen.slice(-1024))}`, { cause: error });
  } finally {
    writer.releaseLock(); await retireTerminal(terminal); await draining;
  }
}
async function retireTerminal(terminal: TerminalHandle): Promise<void> { await terminal.kill("SIGKILL", { scope: "process-group" }); await terminal.exit; }
async function until(checkpoint: string, ready: () => boolean, fault: () => unknown, stopped: () => boolean): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!ready()) {
    const error = fault(); if (error !== undefined) throw error instanceof Error ? error : new Error("terminal output failed");
    if (stopped() || signal.aborted || performance.now() >= deadline) throw new Error(`terminal did not reach the ${checkpoint} checkpoint`);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
void run().catch((error: unknown) => { checks.set(current, { check: current, status: "failed", message: explanation(error) }); }).finally(async () => {
  try { await vm?.dispose(); } catch (error) {
    const previous = checks.get("persistence-reopen");
    checks.set("persistence-reopen", { check: "persistence-reopen", status: "failed", message: `${previous?.status === "failed" ? `${previous.message}; cleanup: ` : ""}${explanation(error)}`.slice(0, 8192) });
  }
  for (const check of IMAGE_TEST_CHECKS) if (!checks.has(check)) checks.set(check, { check, status: "failed", message: "not reached after a preceding failure" });
  output.textContent = JSON.stringify([...checks.values()]); output.dataset["done"] = "true";
}).catch((error: unknown) => { output.textContent = JSON.stringify(IMAGE_TEST_CHECKS.map(check => ({ check, status: "failed", message: explanation(error) }))); output.dataset["done"] = "true"; });
