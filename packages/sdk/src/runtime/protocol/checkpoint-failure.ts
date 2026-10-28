import { exactKeys, record, string } from "../decode.js";
import { VMError } from "../errors.js";

// ABI37 admission phase/domain/owner discriminants are closed Rust projections.
export const CHECKPOINT_BEGIN_PHASES = ["owner-read", "image", "quiesce", "reserve", "baseline", "initial-round", "attachment"] as const;
export const CHECKPOINT_DOMAINS = ["state", "codec", "memory", "runtime", "boundary", "core"] as const;
export const CHECKPOINT_OWNERS = ["version", "image", "policy", "bounds", "reference", "state", "clock", "host", "clock-read", "filesystem",
  "execution", "process", "collections", "files", "file-operation", "memory", "vfs", "namespace", "cgroup", "signals",
  "keyring", "pty", "persistence", "workspace", "scheduler"] as const;

export type CheckpointBeginPhase = (typeof CHECKPOINT_BEGIN_PHASES)[number];
export type CheckpointDomain = (typeof CHECKPOINT_DOMAINS)[number];
export type CheckpointOwner = (typeof CHECKPOINT_OWNERS)[number];

/** Why the engine refused to begin a checkpoint: safe, closed names only. */
export interface CheckpointFailureSummary {
  readonly phase: CheckpointBeginPhase;
  readonly domain: CheckpointDomain;
  readonly owner?: CheckpointOwner;
  /** The decoded native error path, outermost first, for example ["not-quiesced"]. */
  readonly causes: readonly string[];
}

// Causes are names from the SDK's own native error tree (lowercase names, errno names).
const CAUSE = /^[A-Za-z0-9][A-Za-z0-9-]{0,47}$/u;
const MAX_CAUSES = 9;

/** The summary of a `checkpoint-begin-rejected` VMError detail; undefined for anything else. */
export function checkpointFailureSummary(detail: unknown): CheckpointFailureSummary | undefined {
  try {
    const input = record(detail, "checkpoint failure detail");
    if (input["reason"] !== "checkpoint-begin-rejected") return undefined;
    return decodeCheckpointFailureSummary({
      phase: input["phase"], domain: input["domain"],
      ...(input["owner"] === undefined ? {} : { owner: input["owner"] }),
      causes: input["nativeCauses"] ?? [],
    });
  } catch { return undefined; }
}

export function decodeCheckpointFailureSummary(value: unknown): CheckpointFailureSummary {
  const input = record(value, "checkpoint failure"); exactKeys(input, ["phase", "domain", "causes"], ["owner"]);
  const phase = CHECKPOINT_BEGIN_PHASES.find(name => name === input["phase"]);
  const domain = CHECKPOINT_DOMAINS.find(name => name === input["domain"]);
  const owner = input["owner"] === undefined ? undefined : CHECKPOINT_OWNERS.find(name => name === input["owner"]);
  const rawCauses = input["causes"];
  if (phase === undefined || domain === undefined || input["owner"] !== undefined && owner === undefined || !Array.isArray(rawCauses) || rawCauses.length > MAX_CAUSES) invalid();
  const causes = rawCauses.map((cause: unknown) => { const name = string(cause, "checkpoint failure cause"); if (!CAUSE.test(name)) invalid(); return name; });
  return { phase, domain, ...(owner === undefined ? {} : { owner }), causes };
}

function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Checkpoint failure summary is invalid"); }
