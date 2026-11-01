import { createVM, defineImage, VMError } from "../../index.js";
import type { ProcessExit, ProcessHandle, UserspaceVM } from "../../index.js";
import { exactKeys, integer, record, string } from "../../runtime/decode.js";
import { moduleHandle, type LaunchPins, type PinnedFile } from "../../wasm/handle.js";
import { decodeResolvedManifest, isServiceDecl } from "../../wasm/manifest.js";
import { runProperties, type ConformancePorts, type StartedModule } from "../../wasm/conformance/properties.js";
import { probeHandle, probeTargets, refusedEndpoints } from "../../wasm/conformance/probe.js";
import { spawnModule, stopModule } from "../../wasm/spawn.js";

// The page of `oxidevm wasm test`: it runs the property catalog in a real Userspace VM and writes
// `{ "properties": [...] }` or `{ "error": {...} }` into #oxidevm-qualification for the Node side to decode.
const output = document.createElement("pre"); output.id = "oxidevm-qualification"; document.body.append(output);
const MAX_STDERR_CHARS = 64 * 1024;
const decoder = new TextDecoder();

function pin(value: unknown, label: string): PinnedFile {
  const item = record(value, label); exactKeys(item, ["url", "sha256", "bytes"]);
  return { url: string(item["url"], `${label} url`), sha256: string(item["sha256"], `${label} sha256`), bytes: integer(item["bytes"], `${label} bytes`, 0) };
}

function pins(value: unknown, label: string): LaunchPins {
  const item = record(value, label); exactKeys(item, ["release", "adapter", "artifacts"]);
  const artifacts = record(item["artifacts"], `${label} artifacts`);
  return { release: string(item["release"], `${label} release`), adapter: pin(item["adapter"], `${label} adapter`), artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, entry]) => [name, pin(entry, `${label} artifact ${name}`)])) };
}

/** Reads a stream to the end, keeping at most the last `MAX_STDERR_CHARS` characters. */
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let collected = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return (collected + decoder.decode()).slice(-MAX_STDERR_CHARS);
      collected = (collected + decoder.decode(part.value, { stream: true })).slice(-MAX_STDERR_CHARS);
    }
  } catch { return collected; } finally { reader.releaseLock(); }
}

function started(process: ProcessHandle): StartedModule {
  void text(process.stdout);
  return { process, stderr: text(process.stderr) };
}

async function run(): Promise<unknown> {
  const response = await fetch("/fixture.json");
  if (!response.ok) throw new VMError("PROTOCOL_ERROR", "the wasm test configuration is unavailable");
  const config = record(await response.json(), "wasm test configuration");
  exactKeys(config, ["image", "module", "args", "options", "commandMs"]);
  const location = record(config["image"], "image"), trust = record(location["trust"], "image trust");
  const image = defineImage({ mode: "userspace", manifestUrl: string(location["manifestUrl"], "manifest URL"), manifestSHA256: string(location["manifestSHA256"], "manifest digest"), trust: { algorithm: "Ed25519", keyId: string(trust["keyId"], "key id"), publicKey: string(trust["publicKey"], "public key") } });
  const subjectConfig = record(config["module"], "module");
  exactKeys(subjectConfig, ["manifest", "genuine", "tampered"]);
  const manifest = decodeResolvedManifest(subjectConfig["manifest"]);
  const genuine = moduleHandle(manifest, pins(subjectConfig["genuine"], "genuine")), tampered = moduleHandle(manifest, pins(subjectConfig["tampered"], "tampered"));
  const args = Array.isArray(config["args"]) ? Array.from<unknown>(config["args"]).map(value => string(value, "argument")) : [];
  const options = record(config["options"], "options");
  const workspaceId = `wasm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const vm: UserspaceVM = await createVM({ mode: "userspace", image, workspaceId, restorePoint: "none", commandInterceptors: "off", network: { mode: "local" } });
  try {
    const probe = await probeHandle();
    const ports: ConformancePorts = {
      now: () => performance.now(),
      start: async copy => started(await spawnModule(vm, copy === "genuine" ? genuine : tampered, { workspaceId, options, ...(isServiceDecl(manifest) ? {} : { args }) })),
      stop: (process, graceMs) => stopModule(process, { graceMs }),
      capture: async () => { await vm.snapshots.capture({ label: "wasm-test" }); },
      probe: async endpoints => {
        const targets = probeTargets(endpoints);
        const running = started(await spawnModule(vm, probe, { args: targets.map(entry => entry.target) }));
        const [exit, stderr]: [ProcessExit, string] = await Promise.all([running.process.exit, running.stderr]);
        const refused = refusedEndpoints(targets, stderr);
        return exit.kind === "exited" && exit.code === 0 ? [] : refused.length > 0 ? refused : targets.map(entry => entry.name);
      },
    };
    const properties = await runProperties({ kind: isServiceDecl(manifest) ? "service" : "command", endpoints: isServiceDecl(manifest) ? manifest.expose : {} }, ports, { commandMs: integer(config["commandMs"], "commandMs", 1) });
    return { properties };
  } finally { await vm.dispose(); }
}

run().then(
  result => { output.textContent = JSON.stringify(result); },
  (error: unknown) => {
    const failure = error instanceof VMError ? { code: error.code, message: error.message } : { code: "FEATURE_NOT_AVAILABLE", message: error instanceof Error ? error.message : "the wasm test page failed" };
    output.textContent = JSON.stringify({ error: { code: failure.code, message: failure.message.slice(0, 2048) } });
  },
).finally(() => { output.dataset["done"] = "true"; });
