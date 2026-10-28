import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { nonnegativeBigint } from "./decoders.js";

// Read archived JIT-54 experiments; the production core emits no specialized loops.

const DECISIONS = ["disabled", "not-system", "not-tier2", "not-regional", "no-backedge", "no-simple-cycle", "search-limit", "unsupported-operation", "read-count", "address-recurrence", "selected"] as const;
export const JIT_LOOP_SPANS = ["ordinary", "specialized", "guard-mode", "guard-cpl", "guard-shadow", "guard-alignment", "guard-budget", "guard-wrap", "guard-page", "guard-tag", "guard-epoch", "guard-ram", "guard-window", "loop-control"] as const;
export type JitLoopSpan = typeof JIT_LOOP_SPANS[number];
export interface JitLoopPolicy {
  readonly enabled: boolean;
  readonly decision: typeof DECISIONS[number];
  readonly nodes: readonly number[];
  readonly reads: readonly { readonly instructionIndex: number; readonly sourceIndex: number; readonly width: number; readonly headerBias: bigint; readonly stride: bigint }[];
}

export function decodeJitLoopSpan(value: unknown): JitLoopSpan {
  const span = string(value, "JIT loop span");
  const decoded = JIT_LOOP_SPANS.find((candidate) => candidate === span);
  if (decoded === undefined) throw new TypeError("invalid JIT loop span");
  return decoded;
}

export function decodeJitLoopPolicy(bytes: Uint8Array, instructionCount: number): JitLoopPolicy {
  if (bytes.byteLength < 12) throw new TypeError("truncated JIT loop policy");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodeCount = view.getUint16(6, true);
  const readCount = view.getUint16(8, true);
  const decision = DECISIONS[view.getUint8(5)];
  if (view.getUint32(0, true) !== 1 || view.getUint8(4) > 1 || view.getUint16(10, true) !== 0
    || decision === undefined || nodeCount > 32 || readCount > 2
    || bytes.byteLength !== 12 + nodeCount * 2 + readCount * 20) throw new TypeError("invalid JIT loop policy");
  const nodes = Array.from({ length: nodeCount }, (_, index) => view.getUint16(12 + index * 2, true));
  const reads = Array.from({ length: readCount }, (_, index) => {
    const offset = 12 + nodeCount * 2 + index * 20;
    return { instructionIndex: view.getUint16(offset, true), sourceIndex: view.getUint8(offset + 2),
      width: view.getUint8(offset + 3), headerBias: view.getBigUint64(offset + 4, true), stride: view.getBigUint64(offset + 12, true) };
  });
  return decodeJitLoopPolicyRecord({ enabled: view.getUint8(4) === 1, decision, nodes, reads }, instructionCount);
}

export function decodeJitLoopPolicyRecord(value: unknown, instructionCount: number): JitLoopPolicy {
  const policy = record(value, "JIT loop policy");
  exactKeys(policy, ["enabled", "decision", "nodes", "reads"]);
  const enabled = boolean(policy["enabled"], "JIT loop enabled");
  const decision = DECISIONS.find((candidate) => candidate === policy["decision"]);
  const rawNodes = policy["nodes"];
  const rawReads = policy["reads"];
  if (decision === undefined || !Array.isArray(rawNodes) || !Array.isArray(rawReads)
    || rawNodes.length > 32 || rawReads.length > 2 || enabled === (decision === "disabled")) throw new TypeError("invalid JIT loop policy");
  const nodes = rawNodes.map((value: unknown) => integer(value, "JIT loop instruction", 0, instructionCount - 1));
  const reads = rawReads.map((value: unknown) => {
    const read = record(value, "JIT loop read");
    exactKeys(read, ["instructionIndex", "sourceIndex", "width", "headerBias", "stride"]);
    const width = integer(read["width"], "JIT loop read width", 1, 8);
    const instructionIndex = integer(read["instructionIndex"], "JIT loop read instruction", 0, instructionCount - 1);
    const headerBias = nonnegativeBigint(read["headerBias"], "JIT loop header bias");
    const stride = nonnegativeBigint(read["stride"], "JIT loop stride");
    if (!nodes.includes(instructionIndex) || (width & (width - 1)) !== 0 || (headerBias | stride) > 0xffff_ffff_ffff_ffffn) throw new TypeError("invalid JIT loop read");
    return { instructionIndex, sourceIndex: integer(read["sourceIndex"], "JIT loop read source", 0, 23), width, headerBias, stride };
  });
  if (new Set(nodes).size !== nodes.length || new Set(reads.map((read) => `${String(read.instructionIndex)}:${String(read.sourceIndex)}`)).size !== reads.length
    || (decision === "selected" ? nodes.length < 2 || reads.length < 1 : nodes.length !== 0 || reads.length !== 0)) throw new TypeError("inconsistent JIT loop policy");
  return { enabled, decision, nodes, reads };
}

const GUARDS = ["mode", "cpl", "shadow", "alignment", "budget", "wrap", "page", "tag", "epoch", "ram", "window"] as const;
const EXITS = ["branch", "budget", "window"] as const;
export interface JitLoopStats {
  readonly chunks: bigint;
  readonly backedges: bigint;
  readonly retired: bigint;
  readonly guards: Readonly<Record<typeof GUARDS[number], bigint>>;
  readonly exits: Readonly<Record<typeof EXITS[number], bigint>>;
}

export function decodeJitLoopStats(value: unknown): JitLoopStats {
  const stats = record(value, "JIT loop counters");
  exactKeys(stats, ["chunks", "backedges", "retired", "guards", "exits"]);
  const rawGuards = record(stats["guards"], "JIT loop guard counters"); exactKeys(rawGuards, GUARDS);
  const rawExits = record(stats["exits"], "JIT loop exit counters"); exactKeys(rawExits, EXITS);
  const guard = (name: typeof GUARDS[number]) => nonnegativeBigint(rawGuards[name], `JIT loop guard ${name}`);
  const exit = (name: typeof EXITS[number]) => nonnegativeBigint(rawExits[name], `JIT loop exit ${name}`);
  const chunks = nonnegativeBigint(stats["chunks"], "JIT loop chunks");
  const backedges = nonnegativeBigint(stats["backedges"], "JIT loop backedges");
  const retired = nonnegativeBigint(stats["retired"], "JIT loop retired");
  const exits = { branch: exit("branch"), budget: exit("budget"), window: exit("window") };
  if (chunks !== exits.branch + exits.budget + exits.window || retired < backedges * 2n) throw new TypeError("inconsistent JIT loop counters");
  return { chunks, backedges, retired, exits, guards: { mode: guard("mode"), cpl: guard("cpl"), shadow: guard("shadow"), alignment: guard("alignment"), budget: guard("budget"), wrap: guard("wrap"), page: guard("page"), tag: guard("tag"), epoch: guard("epoch"), ram: guard("ram"), window: guard("window") } };
}
