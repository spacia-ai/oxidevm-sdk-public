import { decodeCodeSegmentContext } from "./code-segment-context.js";
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { nonnegativeBigint } from "./decoders.js";
import type {
  CoreJitAdmissionSiteProfile,
  CoreWorkloadProfile,
} from "./system.js";

export function emptyCoreWorkloadProfile(): CoreWorkloadProfile {
  return {
    samplePeriod: 0,
    instructionAttempts: 0n,
    instructionCommits: 0n,
    siteSamples: 0n,
    droppedSiteSamples: 0n,
    unmappedAdmissionSites: 0n,
    semanticAttempts: [],
    semanticCommits: [],
    sites: [],
    admissionSites: [],
    cacheConflictCapacity: 0,
    cacheConflictSamplePeriod: 0,
    cacheConflictSamples: 0n,
    droppedCacheConflicts: 0n,
    cacheConflicts: [],
  };
}

export function decodeCoreWorkloadProfile(
  value: unknown,
  enabled: boolean,
  schemaVersion: number,
): CoreWorkloadProfile {
  const withBlockedReason = schemaVersion >= 21;
  const withInstructionIdentity = schemaVersion >= 22;
  const withCacheConflicts = schemaVersion >= 23;
  const withCacheConflictPairs = schemaVersion >= 24;
  const workload = record(value, "core workload profile");
  const cacheKeys = [
    "cacheConflictCapacity",
    "droppedCacheConflicts",
    "cacheConflicts",
  ] as const;
  const cachePairKeys = [
    "cacheConflictSamplePeriod",
    "cacheConflictSamples",
  ] as const;
  exactKeys(
    workload,
    [
      "samplePeriod",
      "instructionAttempts",
      "instructionCommits",
      "siteSamples",
      "droppedSiteSamples",
      "unmappedAdmissionSites",
      "semanticAttempts",
      "semanticCommits",
      "sites",
      "admissionSites",
      ...(withCacheConflicts ? cacheKeys : []),
      ...(withCacheConflictPairs ? cachePairKeys : []),
    ],
    [
      ...(withCacheConflicts ? [] : cacheKeys),
      ...(withCacheConflictPairs ? [] : cachePairKeys),
    ],
  );
  const providedCacheKeys = cacheKeys.filter((key) => workload[key] !== undefined);
  if (providedCacheKeys.length !== 0 && providedCacheKeys.length !== cacheKeys.length) {
    throw new VMError("PROTOCOL_ERROR", "cache-conflict profile is incomplete");
  }
  const decodeCache = withCacheConflicts || providedCacheKeys.length !== 0;
  const providedCachePairKeys = cachePairKeys.filter(
    (key) => workload[key] !== undefined,
  );
  if (
    providedCachePairKeys.length !== 0 &&
    providedCachePairKeys.length !== cachePairKeys.length
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "cache-conflict pair profile is incomplete",
    );
  }
  const decodeCachePairs = withCacheConflictPairs;
  if (
    !withCacheConflictPairs &&
    providedCachePairKeys.length !== 0 &&
    (integer(
      workload["cacheConflictSamplePeriod"],
      "legacy cache-conflict sample period",
      0,
    ) !== 0 ||
      nonnegativeBigint(
        workload["cacheConflictSamples"],
        "legacy sampled cache conflicts",
      ) !== 0n)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "legacy cache-conflict pair profile is not empty",
    );
  }
  const samplePeriod = integer(
    workload["samplePeriod"],
    "workload sample period",
    0,
  );
  const instructionAttempts = nonnegativeBigint(
    workload["instructionAttempts"],
    "workload instruction attempts",
  );
  const instructionCommits = nonnegativeBigint(
    workload["instructionCommits"],
    "workload instruction commits",
  );
  const siteSamples = nonnegativeBigint(
    workload["siteSamples"],
    "workload site samples",
  );
  const droppedSiteSamples = nonnegativeBigint(
    workload["droppedSiteSamples"],
    "workload dropped site samples",
  );
  const unmappedAdmissionSites = nonnegativeBigint(
    workload["unmappedAdmissionSites"],
    "workload unmapped admission sites",
  );
  const semanticAttempts = bigintArray(
    workload["semanticAttempts"],
    "workload semantic attempts",
    4_096,
  );
  const semanticCommits = bigintArray(
    workload["semanticCommits"],
    "workload semantic commits",
    4_096,
  );
  const cacheConflictCapacity = decodeCache
    ? integer(
        workload["cacheConflictCapacity"],
        "cache-conflict capacity",
        0,
        4_096,
      )
    : 0;
  const droppedCacheConflicts = decodeCache
    ? nonnegativeBigint(
        workload["droppedCacheConflicts"],
        "dropped cache conflicts",
      )
    : 0n;
  const cacheConflicts = decodeCache
    ? decodeCacheConflicts(
        workload["cacheConflicts"],
        cacheConflictCapacity,
        decodeCachePairs,
      )
    : [];
  const cacheConflictSamplePeriod = decodeCachePairs
    ? integer(
        workload["cacheConflictSamplePeriod"],
        "cache-conflict sample period",
        0,
      )
    : withCacheConflicts
      ? 1
      : 0;
  const retainedCacheConflictSamples = cacheConflicts.reduce(
    (total, conflict) => total + conflict.sampledConflicts,
    0n,
  );
  const cacheConflictSamples = decodeCachePairs
    ? nonnegativeBigint(
        workload["cacheConflictSamples"],
        "sampled cache conflicts",
      )
    : retainedCacheConflictSamples + droppedCacheConflicts;
  if (
    !withCacheConflicts &&
    (cacheConflictCapacity !== 0 ||
      cacheConflictSamplePeriod !== 0 ||
      cacheConflictSamples !== 0n ||
      droppedCacheConflicts !== 0n ||
      cacheConflicts.length !== 0)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "legacy cache-conflict profile is not empty",
    );
  }
  if (!enabled) {
    const sites = boundedArray(workload["sites"], "workload sites", 65_536);
    const admissionSites = boundedArray(
      workload["admissionSites"],
      "workload admission sites",
      32_768,
    );
    if (
      samplePeriod !== 0 ||
      instructionAttempts !== 0n ||
      instructionCommits !== 0n ||
      siteSamples !== 0n ||
      droppedSiteSamples !== 0n ||
      unmappedAdmissionSites !== 0n ||
      semanticAttempts.length !== 0 ||
      semanticCommits.length !== 0 ||
      sites.length !== 0 ||
      admissionSites.length !== 0 ||
      cacheConflictCapacity !== 0 ||
      cacheConflictSamplePeriod !== 0 ||
      cacheConflictSamples !== 0n ||
      droppedCacheConflicts !== 0n ||
      cacheConflicts.length !== 0
    ) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "disabled core workload profile is not empty",
      );
    }
    return emptyCoreWorkloadProfile();
  }
  if (
    semanticAttempts.length !== semanticCommits.length ||
    semanticAttempts.length === 0 ||
    samplePeriod === 0 ||
    instructionCommits > instructionAttempts
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "core workload profile counters do not agree",
    );
  }
  if (
    decodeCachePairs &&
    (cacheConflictSamplePeriod === 0 ||
      retainedCacheConflictSamples + droppedCacheConflicts !==
        cacheConflictSamples)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "cache-conflict sample counters do not agree",
    );
  }
  let totalAttempts = 0n;
  let totalCommits = 0n;
  for (let index = 0; index < semanticAttempts.length; index += 1) {
    const attempts = semanticAttempts[index] ?? 0n;
    const commits = semanticCommits[index] ?? 0n;
    if (commits > attempts) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "core workload semantic counters do not agree",
      );
    }
    totalAttempts += attempts;
    totalCommits += commits;
  }
  if (
    totalAttempts !== instructionAttempts ||
    totalCommits !== instructionCommits
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "core workload semantic totals do not agree",
    );
  }
  const rawSites = boundedArray(workload["sites"], "workload sites", 65_536);
  const sites = rawSites.map((site, index) => {
    const decoded = record(site, `workload site ${String(index)}`);
    exactKeys(decoded, [
      "rip",
      "physicalFrame",
      "generation",
      "firstAttempt",
      "lastAttempt",
      "samples",
      "committedSamples",
      "entryOffset",
      "codeAttributes",
      ...(schemaVersion >= 45 ? ["capabilityRevision"] : []),
      ...(schemaVersion >= 48 ? ["codeSegmentBase", "codeSegmentLimit"] : []),
      "semantic",
      ...(withInstructionIdentity ? ["instructionId", "addressSpace", "identityAvailability"] : []),
      "mode",
      "cpl",
      "profile",
    ], [...(schemaVersion < 45 ? ["capabilityRevision"] : []), ...(schemaVersion < 48 ? ["codeSegmentBase", "codeSegmentLimit"] : [])]);
    const firstAttempt = nonnegativeBigint(
      decoded["firstAttempt"],
      "workload site first attempt",
    );
    const lastAttempt = nonnegativeBigint(
      decoded["lastAttempt"],
      "workload site last attempt",
    );
    const samples = nonnegativeBigint(
      decoded["samples"],
      "workload site samples",
    );
    const committedSamples = nonnegativeBigint(
      decoded["committedSamples"],
      "workload site committed samples",
    );
    const semantic = integer(
      decoded["semantic"],
      "workload site semantic",
      0,
      semanticAttempts.length - 1,
    );
    if (
      firstAttempt === 0n ||
      firstAttempt > lastAttempt ||
      lastAttempt > instructionAttempts ||
      samples === 0n ||
      committedSamples > samples
    ) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "core workload site counters do not agree",
      );
    }
    return {
      rip: nonnegativeBigint(decoded["rip"], "workload site RIP"),
      physicalFrame: alignedFrame(
        decoded["physicalFrame"],
        "workload site physical frame",
      ),
      generation: nonnegativeBigint(
        decoded["generation"],
        "workload site generation",
      ),
      firstAttempt,
      lastAttempt,
      samples,
      committedSamples,
      entryOffset: integer(
        decoded["entryOffset"],
        "workload site entry offset",
        0,
        0xfff,
      ),
      codeAttributes: integer(
        decoded["codeAttributes"],
        "workload site code attributes",
        0,
        0xffff,
      ),
      semantic,
      instructionId: withInstructionIdentity
        ? integer(decoded["instructionId"], "workload site instruction form", 0, 0xffff)
        : null,
      addressSpace: withInstructionIdentity
        ? nonnegativeBigint(decoded["addressSpace"], "workload site address space")
        : null,
      identityAvailability: withInstructionIdentity
        ? "measured"
        : "unavailable:legacy-record",
      mode: workloadMode(decoded["mode"]),
      cpl: workloadCpl(decoded["cpl"]),
      profile: workloadCpuProfile(decoded["profile"]),
      capabilityRevision: workloadCapabilityRevision(decoded["capabilityRevision"], schemaVersion),
      ...decodeCodeSegmentContext(decoded["codeSegmentBase"], decoded["codeSegmentLimit"], decoded["mode"] === 3, schemaVersion >= 48),
    } as const;
  });
  const retainedSamples = sites.reduce(
    (total, site) => total + site.samples,
    0n,
  );
  if (retainedSamples + droppedSiteSamples !== siteSamples) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "core workload site totals do not agree",
    );
  }
  const rawAdmissionSites = boundedArray(
    workload["admissionSites"],
    "workload admission sites",
    65_536,
  );
  const admissionSites = rawAdmissionSites.map((site, index) => {
    const decoded = record(site, `workload admission site ${String(index)}`);
    exactKeys(decoded, [
      "rip",
      "physicalFrame",
      "generation",
      "firstObservation",
      "lastObservation",
      "entryOffset",
      "visits",
      "requiredVisits",
      "codeAttributes",
      ...(schemaVersion >= 45 ? ["capabilityRevision"] : []),
      ...(schemaVersion >= 48 ? ["codeSegmentBase", "codeSegmentLimit"] : []),
      "mode",
      "cpl",
      "profile",
      "blocked",
      ...(withBlockedReason ? ["blockedReason"] : []),
      "admitted",
      "cached",
    ], [...(schemaVersion < 45 ? ["capabilityRevision"] : []), ...(schemaVersion < 48 ? ["codeSegmentBase", "codeSegmentLimit"] : [])]);
    const firstObservation = nonnegativeBigint(
      decoded["firstObservation"],
      "admission first observation",
    );
    const lastObservation = nonnegativeBigint(
      decoded["lastObservation"],
      "admission last observation",
    );
    const visits = integer(decoded["visits"], "admission visits", 0, 0xffff);
    const requiredVisits = integer(
      decoded["requiredVisits"],
      "admission required visits",
      1,
      0xffff,
    );
    const blocked = boolean(decoded["blocked"], "admission blocked");
    const blockedReason = withBlockedReason
      ? decodeBlockedReason(decoded["blockedReason"])
      : null;
    const admitted = boolean(decoded["admitted"], "admission admitted");
    const cached = boolean(decoded["cached"], "admission cached");
    if (
      firstObservation === 0n ||
      firstObservation > lastObservation ||
      (withBlockedReason && blocked !== (blockedReason !== null)) ||
      admitted !== (!blocked && (cached || visits >= requiredVisits)) ||
      (cached && !admitted)
    ) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "core workload admission state does not agree",
      );
    }
    return {
      rip: nonnegativeBigint(decoded["rip"], "admission RIP"),
      physicalFrame: alignedFrame(
        decoded["physicalFrame"],
        "admission physical frame",
      ),
      generation: nonnegativeBigint(
        decoded["generation"],
        "admission generation",
      ),
      firstObservation,
      lastObservation,
      entryOffset: integer(
        decoded["entryOffset"],
        "admission entry offset",
        0,
        0xfff,
      ),
      visits,
      requiredVisits,
      codeAttributes: integer(
        decoded["codeAttributes"],
        "admission code attributes",
        0,
        0xffff,
      ),
      mode: workloadMode(decoded["mode"]),
      cpl: workloadCpl(decoded["cpl"]),
      profile: workloadCpuProfile(decoded["profile"]),
      capabilityRevision: workloadCapabilityRevision(decoded["capabilityRevision"], schemaVersion),
      ...decodeCodeSegmentContext(decoded["codeSegmentBase"], decoded["codeSegmentLimit"], decoded["mode"] === 3, schemaVersion >= 48),
      blocked,
      blockedReason,
      admitted,
      cached,
    } as const;
  });
  return {
    samplePeriod,
    instructionAttempts,
    instructionCommits,
    siteSamples,
    droppedSiteSamples,
    unmappedAdmissionSites,
    semanticAttempts,
    semanticCommits,
    sites,
    admissionSites,
    cacheConflictCapacity,
    cacheConflictSamplePeriod,
    cacheConflictSamples,
    droppedCacheConflicts,
    cacheConflicts,
  };
}

function decodeCacheConflicts(
  value: unknown,
  capacity: number,
  withPairs: boolean,
): CoreWorkloadProfile["cacheConflicts"] {
  const raw = boundedArray(value, "cache-conflict buckets", 4_096);
  if (raw.length > capacity) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "cache-conflict buckets exceed their capacity",
    );
  }
  const seen = new Set<string>();
  return raw.map((candidate, index) => {
    const bucket = record(candidate, `cache-conflict bucket ${String(index)}`);
    exactKeys(
      bucket,
      withPairs
        ? [
            "kind",
            "index",
            "incomingTag",
            "displacedTag",
            "addressSpace",
            "sampledConflicts",
            "alternations",
            "reuseDistance",
            "pairAvailability",
          ]
        : ["kind", "identity", "addressSpace", "conflicts"],
    );
    const kind = string(bucket["kind"], "cache-conflict kind");
    if (kind !== "dispatch" && kind !== "read" && kind !== "write") {
      throw new VMError("PROTOCOL_ERROR", "cache-conflict kind is invalid");
    }
    const addressSpace = nonnegativeBigint(
      bucket["addressSpace"],
      "cache-conflict address space",
    );
    const cacheIndex = withPairs
      ? integer(
          bucket["index"],
          "cache-conflict index",
          0,
          65_535,
        )
      : null;
    const legacyIdentity = withPairs
      ? null
      : nonnegativeBigint(bucket["identity"], "cache-conflict identity");
    const incomingTag = withPairs
      ? nonnegativeBigint(bucket["incomingTag"], "incoming cache tag")
      : kind === "dispatch"
        ? (legacyIdentity ?? 0n)
        : (legacyIdentity ?? 0n) >> 12n;
    const displacedTag = withPairs
      ? nonnegativeBigint(bucket["displacedTag"], "displaced cache tag")
      : null;
    const sampledConflicts = nonnegativeBigint(
      bucket[withPairs ? "sampledConflicts" : "conflicts"],
      "sampled cache conflicts",
    );
    const alternations = withPairs
      ? nonnegativeBigint(
          bucket["alternations"],
          "cache-conflict alternations",
        )
      : 0n;
    const reuseDistance = withPairs
      ? decodeCacheConflictDistance(bucket["reuseDistance"])
      : emptyCacheConflictDistance();
    const pairAvailability = withPairs
      ? string(
          bucket["pairAvailability"],
          "cache-conflict pair availability",
        )
      : "unavailable:legacy-record";
    const reuseSamples =
      reuseDistance["0-15"] +
      reuseDistance["16-63"] +
      reuseDistance["64-255"] +
      reuseDistance["256-1023"] +
      reuseDistance["1024+"];
    const key = `${kind}:${String(cacheIndex)}:${incomingTag.toString(16)}:${String(displacedTag)}:${addressSpace.toString(16)}`;
    if (
      sampledConflicts === 0n ||
      alternations > sampledConflicts ||
      (withPairs ? reuseSamples + 1n !== sampledConflicts : reuseSamples !== 0n) ||
      pairAvailability !==
        (withPairs ? "measured" : "unavailable:legacy-record") ||
      seen.has(key)
    ) {
      throw new VMError("PROTOCOL_ERROR", "cache-conflict bucket is invalid");
    }
    seen.add(key);
    return {
      kind,
      index: cacheIndex,
      incomingTag,
      displacedTag,
      addressSpace,
      sampledConflicts,
      alternations,
      reuseDistance,
      pairAvailability,
    };
  });
}

function decodeCacheConflictDistance(
  value: unknown,
): CoreWorkloadProfile["cacheConflicts"][number]["reuseDistance"] {
  const buckets = record(value, "cache-conflict reuse distance");
  exactKeys(buckets, ["0-15", "16-63", "64-255", "256-1023", "1024+"]);
  return {
    "0-15": nonnegativeBigint(
      buckets["0-15"],
      "cache-conflict reuse distance 0-15",
    ),
    "16-63": nonnegativeBigint(
      buckets["16-63"],
      "cache-conflict reuse distance 16-63",
    ),
    "64-255": nonnegativeBigint(
      buckets["64-255"],
      "cache-conflict reuse distance 64-255",
    ),
    "256-1023": nonnegativeBigint(
      buckets["256-1023"],
      "cache-conflict reuse distance 256-1023",
    ),
    "1024+": nonnegativeBigint(
      buckets["1024+"],
      "cache-conflict reuse distance 1024+",
    ),
  };
}

function emptyCacheConflictDistance(): CoreWorkloadProfile["cacheConflicts"][number]["reuseDistance"] {
  return {
    "0-15": 0n,
    "16-63": 0n,
    "64-255": 0n,
    "256-1023": 0n,
    "1024+": 0n,
  };
}

function decodeBlockedReason(
  value: unknown,
): CoreJitAdmissionSiteProfile["blockedReason"] {
  if (value === null) return null;
  const reason = string(value, "admission blocked reason");
  switch (reason) {
    case "unsupported-semantic":
    case "quarantined-semantic":
    case "unsupported-cpu-context":
    case "translation-fault":
    case "decode-or-translation-fault":
    case "lowering-failure":
    case "emission-failure":
    case "candidate-limit":
    case "module-size-limit":
      return reason;
    default:
      throw new VMError("PROTOCOL_ERROR", "admission blocked reason is invalid");
  }
}

function bigintArray(value: unknown, label: string, maximum: number): bigint[] {
  return boundedArray(value, label, maximum).map((entry, index) =>
    nonnegativeBigint(entry, `${label} ${String(index)}`),
  );
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new VMError("PROTOCOL_ERROR", `${label} is invalid`);
  }
  return value;
}

function alignedFrame(value: unknown, label: string): bigint {
  const frame = nonnegativeBigint(value, label);
  if ((frame & 0xfffn) !== 0n) {
    throw new VMError("PROTOCOL_ERROR", `${label} is unaligned`);
  }
  return frame;
}

function workloadMode(value: unknown): 0 | 1 | 2 | 3 {
  switch (integer(value, "workload CPU mode", 0, 3)) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    default:
      return 3;
  }
}

function workloadCpl(value: unknown): 0 | 1 | 2 | 3 {
  switch (integer(value, "workload CPL", 0, 3)) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    default:
      return 3;
  }
}

function workloadCapabilityRevision(value: unknown, schemaVersion: number): 0 | 1 {
  if (value === undefined && schemaVersion < 45) return 0;
  if (value === 0 || value === 1 && schemaVersion >= 45) return value;
  throw new VMError("PROTOCOL_ERROR", "workload capability revision is invalid");
}

function workloadCpuProfile(value: unknown): 0 | 1 | 2 {
  switch (integer(value, "workload CPU profile", 0, 2)) {
    case 0:
      return 0;
    case 1:
      return 1;
    default:
      return 2;
  }
}
