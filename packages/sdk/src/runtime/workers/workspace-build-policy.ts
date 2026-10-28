import { exactKeys, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeBuildScriptDecisions, type BuildScriptDecision } from "../protocol/build-script-approval.js";
import { digest, parseJson, sha256 } from "./workspace-manifest.js";
import type { WorkspaceStoreBackend } from "./workspace-store.js";

const encodeJson = (value: object) => new TextEncoder().encode(JSON.stringify(value));

const PATH = "build-policy.json";
const MAX_BYTES = 128 * 1024;
const key = (value: BuildScriptDecision) => JSON.stringify([value.name, value.version, value.integrity]);

async function decodePolicy(bytes: Uint8Array<ArrayBuffer>, base?: string): Promise<readonly BuildScriptDecision[]> {
  const value = record(parseJson(bytes), "build policy");
  exactKeys(value, ["formatVersion", "workspaceBaseSha256", "decisions", "sha256"]);
  const workspaceBaseSha256 = value["workspaceBaseSha256"];
  if (typeof workspaceBaseSha256 !== "string") throw new Error("Invalid build policy base");
  digest(workspaceBaseSha256, "workspace base SHA-256");
  if (value["formatVersion"] !== 1 || (base !== undefined && workspaceBaseSha256 !== base)) throw new Error("Build policy identity mismatch");
  const decisions = decodeBuildScriptDecisions(value["decisions"]);
  const payload = { formatVersion: 1, workspaceBaseSha256, decisions };
  if (await sha256(encodeJson(payload)) !== value["sha256"]) throw new Error("Build policy digest mismatch");
  return decisions;
}

/** Called only under WorkspaceStore's read/write lifecycle. */
export async function readBuildPolicy(backend: WorkspaceStoreBackend, base: string, signal?: AbortSignal): Promise<readonly BuildScriptDecision[]> {
  const cancelled = () => signal?.aborted === true;
  digest(base, "workspace base SHA-256");
  const bytes = await backend.read(PATH, MAX_BYTES, signal);
  if (cancelled()) throw new VMError("ABORTED", "Build approval read cancelled");
  if (bytes === undefined) return [];
  let decisions;
  try { decisions = await decodePolicy(bytes, base); }
  catch { throw new VMError("STORAGE_ERROR", "Build approval policy requires recovery", { reason: "build-policy-invalid" }); }
  if (cancelled()) throw new VMError("ABORTED", "Build approval read cancelled");
  return decisions;
}

const INTENT = "build-policy-intent.json";

/** The workspace owner runs recovery once before admitting metadata operations.
 * A durable intent retains the previous sealed record until publication closes. */
export async function recoverBuildPolicy(backend: WorkspaceStoreBackend): Promise<void> {
  const pending = await backend.read(INTENT, 2 * MAX_BYTES);
  if (pending === undefined) return;
  try {
    const active = await backend.read(PATH, MAX_BYTES);
    if (pending.length === 0) {
      // Creating a new OPFS file can survive before its atomic writer closes.
      // No policy mutation is admitted until a complete intent is durable.
      if (active !== undefined) await decodePolicy(active);
      await backend.remove(INTENT);
      return;
    }
    const intent = record(parseJson(pending), "build policy intent");
    exactKeys(intent, ["formatVersion", "previous", "nextSha256", "sha256"]);
    if (intent["formatVersion"] !== 1 || typeof intent["nextSha256"] !== "string") throw new Error("Invalid build policy intent");
    digest(intent["nextSha256"], "next policy digest");
    const payload = { formatVersion: 1, previous: intent["previous"], nextSha256: intent["nextSha256"] };
    if (await sha256(encodeJson(payload)) !== intent["sha256"]) throw new Error("Build policy intent digest mismatch");
    const previous = intent["previous"] === null ? undefined : encodeJson(record(intent["previous"], "previous build policy"));
    if (previous !== undefined) await decodePolicy(previous);
    if (active !== undefined && await sha256(active) === intent["nextSha256"]) {
      await decodePolicy(active);
    } else if (previous === undefined) {
      if (active !== undefined) await backend.remove(PATH);
    } else if (active === undefined || await sha256(active) !== await sha256(previous)) {
      await backend.write(PATH, previous);
    }
    await backend.remove(INTENT);
  } catch {
    throw new VMError("STORAGE_ERROR", "Build approval recovery did not complete", { reason: "build-policy-recovery", cleanupFailed: true });
  }
}

export async function commitBuildPolicy(backend: WorkspaceStoreBackend, base: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const incoming = decodeBuildScriptDecisions(value);
  const current = await readBuildPolicy(backend, base, signal);
  const decisions = new Map(current.map(item => [key(item), item]));
  for (const item of incoming) decisions.set(key(item), item);
  const merged = [...decisions.values()];
  if (merged.length > 4096 || encodeJson(merged).length > 65_536) throw new VMError("QUOTA_EXCEEDED", "Build approval policy exceeds installation bounds");
  const payload = { formatVersion: 1, workspaceBaseSha256: base, decisions: merged };
  const bytes = encodeJson({ ...payload, sha256: await sha256(encodeJson(payload)) });
  const previous = await backend.read(PATH, MAX_BYTES, signal);
  const intent = { formatVersion: 1, previous: previous === undefined ? null : parseJson(previous), nextSha256: await sha256(bytes) };
  const pending = encodeJson({ ...intent, sha256: await sha256(encodeJson(intent)) });
  if (signal?.aborted === true) throw new VMError("ABORTED", "Build approval commit cancelled");
  try {
    await backend.write(INTENT, pending);
    await backend.write(PATH, bytes);
    await backend.remove(INTENT);
  } catch {
    // A rejected close may have committed. Fence writes until a new owner reads
    // and verifies the durable record; never report a lost approval as saved.
    throw new VMError("STORAGE_ERROR", "Build approval commit requires recovery", { reason: "build-policy-uncertain", cleanupFailed: true });
  }
}
