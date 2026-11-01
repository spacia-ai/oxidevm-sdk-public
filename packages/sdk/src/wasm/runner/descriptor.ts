import { exactKeys, record } from "../../runtime/decode.js";
import { decoding, invalid, pinURL, text } from "../decode-support.js";
import { decodePin } from "../manifest-parts.js";
import { decodeResolvedManifest } from "../manifest.js";
import type { ResolvedManifest } from "../manifest-types.js";
import type { PinnedFile } from "../handle.js";

/** Everything the runner needs to start one module; `spawnModule` writes it as the process's first argument. */
export interface LaunchDescriptor {
  readonly v: 1;
  readonly manifest: ResolvedManifest;
  readonly release: string;
  readonly adapter: PinnedFile;
  readonly artifacts: Readonly<Record<string, PinnedFile>>;
  /** As the consumer passed them; the runner resolves them against the manifest again. */
  readonly options: Readonly<Record<string, unknown>>;
  readonly workspaceId?: string;
}

export const MAX_DESCRIPTOR_BYTES = 512 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function decodePinnedFile(value: unknown, label: string): PinnedFile {
  const item = record(value, label);
  exactKeys(item, ["url", "sha256", "bytes"]);
  const { sha256, bytes } = decodePin({ sha256: item["sha256"], bytes: item["bytes"] }, label);
  return { url: pinURL(item["url"], `${label} url`), sha256, bytes };
}

/** A pin must say exactly what the manifest says about the same file. */
function requireSamePin(label: string, pinned: PinnedFile, declared: { readonly sha256: string; readonly bytes: number }): void {
  if (pinned.sha256 !== declared.sha256 || pinned.bytes !== declared.bytes) invalid(label, "does not match the pin in module.json");
}

/** Decodes the descriptor object (already parsed from JSON) and cross-checks every pin against the manifest. */
export function decodeLaunchDescriptor(value: unknown): LaunchDescriptor {
  return decoding("launch descriptor", () => {
    const input = record(value, "launch descriptor");
    exactKeys(input, ["v", "manifest", "release", "adapter", "artifacts", "options"], ["workspaceId"]);
    if (input["v"] !== 1) invalid("launch descriptor", "v must be 1");
    const manifest = decodeResolvedManifest(input["manifest"]);
    const release = text(input["release"], "release", SHA256, 64);
    const adapter = decodePinnedFile(input["adapter"], "adapter");
    requireSamePin("adapter", adapter, manifest.adapter);
    const pins = record(input["artifacts"], "artifacts");
    const declared = new Map(manifest.artifacts.map(artifact => [artifact.name, artifact]));
    for (const name of Object.keys(pins)) if (!declared.has(name)) invalid("artifacts", `${name} is not an artifact of module.json`);
    const artifacts: Record<string, PinnedFile> = {};
    for (const [name, artifact] of declared) {
      if (!Object.hasOwn(pins, name)) invalid("artifacts", `${name} has no pin`);
      artifacts[name] = decodePinnedFile(pins[name], `artifact ${name}`);
      requireSamePin(`artifact ${name}`, artifacts[name], artifact);
    }
    const options = record(input["options"], "options");
    const workspaceId = input["workspaceId"] === undefined ? undefined : text(input["workspaceId"], "workspaceId", WORKSPACE_ID, 128);
    return { v: 1, manifest, release, adapter, artifacts, options, ...(workspaceId === undefined ? {} : { workspaceId }) };
  });
}

/** Parses the first process argument. The size is checked before parsing so a hostile argument cannot cost more. */
export function parseLaunchArgument(argument: string | undefined): LaunchDescriptor {
  return decoding("launch descriptor", () => {
    if (argument === undefined) return invalid("launch descriptor", "is missing");
    if (new TextEncoder().encode(argument).length > MAX_DESCRIPTOR_BYTES) return invalid("launch descriptor", `exceeds ${String(MAX_DESCRIPTOR_BYTES)} bytes`);
    let parsed: unknown;
    try { parsed = JSON.parse(argument); } catch { return invalid("launch descriptor", "is not JSON"); }
    return decodeLaunchDescriptor(parsed);
  });
}

/** The text `spawnModule` passes as the first argument. */
export function encodeLaunchArgument(descriptor: LaunchDescriptor): string {
  const text = JSON.stringify(decodeLaunchDescriptor(descriptor));
  if (new TextEncoder().encode(text).length > MAX_DESCRIPTOR_BYTES) invalid("launch descriptor", `exceeds ${String(MAX_DESCRIPTOR_BYTES)} bytes`);
  return text;
}
