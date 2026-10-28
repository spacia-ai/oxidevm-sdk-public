import { describe, expect, it } from "vitest";

it("decodes generation-qualified named signals, resize and interrupt without allowing malformed controls", () => {
  const common = { id: 1, version: PROTOCOL_VERSION, pid: 2, sessionId: 3 };
  expect(decodeUserspaceRequest({ ...common, type: "signal-named", signal: "SIGUSR1", scope: "process-group" })).toEqual({ ...common, type: "signal-named", signal: "SIGUSR1", scope: "process-group" });
  expect(decodeUserspaceRequest({ ...common, type: "terminal-resize", terminal: { columns: 120, rows: 40 } })).toMatchObject({ terminal: { columns: 120, rows: 40 } });
  expect(decodeUserspaceRequest({ ...common, type: "terminal-interrupt" })).toEqual({ ...common, type: "terminal-interrupt" });
  for (const extra of [{ signal: "BAD" }, { scope: "all" }, { sessionId: 0 }, { leaked: true }]) {
    expect(() => decodeUserspaceRequest({ ...common, type: "signal-named", signal: "SIGTERM", scope: "process", ...extra })).toThrow();
  }
});

import {
  decodeAccelerationNoticeMessage,
  decodeUserspaceRequest,
  decodeUserspaceExecutionProfile,
  userspaceResponseDecoders,
} from "./userspace-protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { EMPTY_CORE_RUNTIME_PROFILE } from "./protocol/system-trace-core-profile.js";
import { emptyUserspaceSliceProfile } from "./protocol/userspace-slices.js";
import { emptyBackgroundCompileProfile } from "./protocol/system-trace-background-compile.js";
import { emptyJitHealthProfile } from "./protocol/system-trace-jit-health.js";
import { emptyInterpreterReasonProfiles } from "./protocol/system-trace-legacy.js";
import { emptyInterpretedActionReasonProfiles } from "./protocol/system-trace-interpreted-actions.js";
import { emptyJitCodeProfile } from "./protocol/system-trace-jit-code.js";

describe("Userspace worker protocol", () => {
  it("accepts an isolated execution capability and rejects older worker versions", () => {
    const channel = new MessageChannel();
    try {
      const request = { id: 1, version: PROTOCOL_VERSION, type: "initialize", wasmUrl: "/userspace.wasm", memoryMiB: 256, nativeExecutionPort: channel.port1 };
      expect(decodeUserspaceRequest(request)).toEqual(request);
      expect(() => decodeUserspaceRequest({ ...request, nativeExecutionPort: {} })).toThrow();
      expect(() => decodeUserspaceRequest({ ...request, version: 71 })).toThrow("protocol version mismatch");
    } finally { channel.port1.close(); channel.port2.close(); }
  });
  it("rejects the pre-rebase experiment protocol before accepting requests", () => {
    expect(() => decodeUserspaceRequest({ id: 1, version: 70, type: "dispose" })).toThrow("protocol version mismatch");
  });
  it("accepts a compiled engine module and refuses fabricated module values", () => {
    const wasmModule = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0));
    const request = { id: 1, version: PROTOCOL_VERSION, type: "initialize", wasmUrl: "/userspace.wasm", memoryMiB: 256, wasmModule };
    expect(decodeUserspaceRequest(request)).toEqual(request);
    for (const broken of [{}, new Uint8Array(), null]) expect(() => decodeUserspaceRequest({ ...request, wasmModule: broken })).toThrow();
  });
  it("validates initial user and root persistence at the worker boundary", () => {
    const request = { id: 1, version: PROTOCOL_VERSION, type: "initialize", wasmUrl: "/userspace.wasm", memoryMiB: 1536 };
    expect(decodeUserspaceRequest(request)).toEqual(request);
    const configured = { ...request, initialUser: "root", rootPersistence: "persistent" };
    expect(decodeUserspaceRequest(configured)).toEqual(configured);
    for (const invalid of [
      { initialUser: 0 }, { initialUser: "admin" }, { rootPersistence: true },
      { rootPersistence: "memory" }, { initialUser: null }, { rootPersistence: null },
      { version: PROTOCOL_VERSION - 1 },
    ]) expect(() => decodeUserspaceRequest({ ...request, ...invalid })).toThrow();
  });
  it("decodes the listening-ports request and its three answers", () => {
    const request = { id: 3, version: PROTOCOL_VERSION, type: "listening-ports" };
    expect(decodeUserspaceRequest({ ...request, known: 4n })).toEqual({ ...request, known: 4n });
    expect(decodeUserspaceRequest({ ...request, known: null })).toEqual({ ...request, known: null });
    for (const invalid of [{ ...request, known: 4 }, { ...request, known: -1n }, { ...request }, { ...request, known: null, port: 3000 }]) {
      expect(() => decodeUserspaceRequest(invalid)).toThrow();
    }
    expect(userspaceResponseDecoders["listening-ports"]({ kind: "none" })).toEqual({ generation: 0n, ports: [] });
    expect(userspaceResponseDecoders["listening-ports"]({ kind: "unchanged", generation: 4n })).toEqual({ generation: 4n, ports: null });
    expect(userspaceResponseDecoders["listening-ports"]({ kind: "listeners", record: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0) }))
      .toEqual({ generation: 2n, ports: [] });
  });

  it("rejects excess keys, stale versions, oversized records, and invalid signals", () => {
    const channel = new MessageChannel();
    expect(
      decodeUserspaceRequest({
        id: 1,
        version: PROTOCOL_VERSION,
        type: "spawn",
        elf: new Uint8Array([1]),
        arguments: ["/program"],
        environment: ["A=B"],
        cwd: "/workspace",
        rootfs: new Uint8Array(),
        port: channel.port1,
      }),
    ).toMatchObject({
      type: "spawn",
      arguments: ["/program"],
      environment: ["A=B"],
      cwd: "/workspace",
    });
    expect(() =>
      decodeUserspaceRequest({
        id: 1,
        version: PROTOCOL_VERSION - 1,
        type: "dispose",
      }),
    ).toThrow("protocol version mismatch");
    expect(() =>
      decodeUserspaceRequest({
        id: 1,
        version: PROTOCOL_VERSION,
        type: "signal",
        pid: 1,
        sessionId: 1,
        signal: "SEGV",
      }),
    ).toThrow("signal is invalid");
    expect(() =>
      decodeUserspaceRequest({
        id: 1,
        version: PROTOCOL_VERSION,
        type: "dispose",
        extra: true,
      }),
    ).toThrow();
    channel.port1.close();
    channel.port2.close();
  });

  it("requires exact managed-root identity", () => {
    const channel = new MessageChannel();
    const request = {
      id: 2,
      version: PROTOCOL_VERSION,
      type: "spawn-managed",
      rootTreeSha256: "a".repeat(64),
      workspaceBaseSha256: "b".repeat(64),
      cpuProfile: "x86-64-v3",
      executable: "/usr/bin/bun",
      arguments: ["/usr/bin/bun", "--version"],
      environment: [],
      cwd: "/",
      rootfs: new Uint8Array(),
      terminal: { columns: 120, rows: 40 },
      port: channel.port1,
    };
    expect(decodeUserspaceRequest(request)).toMatchObject({
      type: "spawn-managed",
      rootTreeSha256: "a".repeat(64),
      workspaceBaseSha256: "b".repeat(64),
      cpuProfile: "x86-64-v3",
      terminal: { columns: 120, rows: 40 },
    });
    expect(() => decodeUserspaceRequest({ ...request, rootTreeSha256: "A".repeat(64) }))
      .toThrow("root tree SHA-256");
    expect(() => decodeUserspaceRequest({ ...request, cpuProfile: "x86-64-v4" }))
      .toThrow("CPU profile");
    expect(() => decodeUserspaceRequest({ ...request, supportingFiles: [] })).toThrow();
    expect(() => decodeUserspaceRequest({ ...request, terminal: { columns: 0, rows: 40 } }))
      .toThrow("terminal columns");
    expect(() => decodeUserspaceRequest({ ...request, terminal: { columns: 80, rows: 24, extra: true } }))
      .toThrow();
    expect(() => decodeUserspaceRequest({ ...request, extra: true })).toThrow();
    channel.port1.close();
    channel.port2.close();
  });

  it("validates syscall tracing at the protocol boundary", () => {
    expect(
      decodeUserspaceRequest({
        id: 1,
        version: PROTOCOL_VERSION,
        type: "initialize",
        wasmUrl: "/userspace.wasm",
        memoryMiB: 512,
        syscallTraceCapacity: 16,
        executionTiming: { kind: "sampled" },
      }),
    ).toMatchObject({ type: "initialize", memoryMiB: 512, syscallTraceCapacity: 16, executionTiming: { kind: "sampled" } });
    expect(
      decodeUserspaceRequest({
        id: 2,
        version: PROTOCOL_VERSION,
        type: "read-syscall-trace",
        pid: 7,
      }),
    ).toMatchObject({ type: "read-syscall-trace", pid: 7 });
    expect(() =>
      decodeUserspaceRequest({
        id: 3,
        version: PROTOCOL_VERSION,
        type: "initialize",
        wasmUrl: "/userspace.wasm",
        memoryMiB: 512,
        syscallTraceCapacity: 4097,
      }),
    ).toThrow("Userspace syscall trace capacity");
    expect(() =>
      decodeUserspaceRequest({
        id: 3,
        version: PROTOCOL_VERSION,
        type: "initialize",
        wasmUrl: "/userspace.wasm",
        memoryMiB: 512,
        executionTiming: { kind: "sampled", extra: true },
      }),
    ).toThrow();
    expect(() =>
      decodeUserspaceRequest({
        id: 4,
        version: PROTOCOL_VERSION,
        type: "initialize",
        wasmUrl: "/userspace.wasm",
        memoryMiB: 3073,
      }),
    ).toThrow("Userspace memory");
  });

  it("validates reconciled Userspace execution profiles", () => {
    expect(
      decodeUserspaceRequest({
        id: 4,
        version: PROTOCOL_VERSION,
        type: "read-execution-profile",
        pid: 7,
      }),
    ).toMatchObject({ type: "read-execution-profile", pid: 7 });
    const profile = {
      pid: 7,
      jitTier: "tier2",
      retiredInstructions: 30n,
      jitInstructions: 20n,
      interpretedInstructions: 10n,
      jitTier1Retired: 12n,
      jitTier2Retired: 8n,
      jitTier1Ring0Retired: 0n,
      jitTier1Ring3Retired: 12n,
      jitTier2Ring0Retired: 0n,
      jitTier2Ring3Retired: 8n,
      guestKernelInstructions: 0n,
      guestDeviceInstructions: 0n,
      guestPageTableWalkInstructions: 0n,
      guestSchedulerInstructions: 0n,
      guestTcpStackInstructions: 0n,
      unknownAttributionInstructions: 0n,
      lastException: null,
      timing: {
        kind: "exact",
        jitMilliseconds: 12.5,
        interpreterMilliseconds: 1.5,
        compileMilliseconds: 2.25,
      },
      jitBatches: 8,
      interpreterBatches: 2,
      compileModules: 4,
      recompiledModules: 1,
      moduleEvictions: 0,
      prepareCalls: 10,
      prepareSamples: 10,
      prepareMilliseconds: 3.5,
      jitChainAttempts: 100n,
      jitChainHits: 90n,
      jitChainMissingCoverage: 1n,
      jitChainMissingCache: 2n,
      jitChainMissingDispatchSlot: 3n,
      jitChainMissingEntry: 1n,
      jitChainInvalidCode: 2n,
      jitChainContextFailures: 1n,
      jitResidentTierLoopCalls: 50n,
      jitHotBlockTransitions: 80n,
      jitHotBoundaryStops: 10n,
      jitPartialBudgetFallbacks: 0n,
      jitTailChainTransitions: 20n,
      jitTier2ExecutionEntries: 5n,
      jitMemoryReads: 100n,
      jitMemoryPreflightWrites: 20n,
      jitMemoryStageWrites: 10n,
      jitMemoryWrites: 5n,
      jitMemoryDirectPreflightWrites: 15n,
      jitReadCacheHits: 900n,
      jitWriteCacheHits: 180n,
      jitReadVictimHits: 0n,
      jitWriteVictimHits: 0n,
      jitResidentAdapterCompletions: 20n,
      jitAdapterExitsReturned: 0n,
      jitResidentTaskSwitches: 2n,
      jitResidentZeroRetirementExhaustions: 0n,
      jitResidentHostWaitExits: 1n,
      jitDispatchRebindSameModuleCrossAddressSpace: 0n,
      jitDispatchRebindDifferentModule: 0n,
      jitDispatchRebindSameAddressSpace: 0n,
      jitBindingInvalidationsUnregister: 0n,
      jitBindingInvalidationsEviction: 0n,
      jitBindingInvalidationsReplacement: 0n,
      jitActiveBindings: 0n,
      jitActiveArtifacts: 0n,
      jitActiveAddressSpaces: 0n,
      jitAliasBindings: 0n,
      jitAliasReuses: 0n,
      jitCacheBindingBytes: 0n,
      jitCacheArtifactBytes: 0n,
      jitCacheTotalBytes: 0n,
      mappedBytes: 8192n,
      residentBytes: 4096n,
      materializedPages: 1n,
      directReadPageFills: 100n,
      directWritePageFills: 20n,
      translationJournalRecorded: 9n,
      translationJournalDrained: 5n,
      translationJournalCoalesced: 2n,
      translationJournalDropped: 1n,
      translationJournalRangeOverflows: 0n,
      translationJournalCodeWriteOverflows: 0n,
      translationJournalTrackedPages: 3n,
      guestClockTicks: 2_560_094n,
      guestClockRetiredTicks: 30n,
      guestClockIdleTicks: 2_560_000n,
      guestClockKernelTicks: 64n,
      kernelAccountingModel: 1,
      realtimeOffsetSteps: 1n,
      workerRunTurns: 4,
      workerYields: 3,
      workerMessages: 2,
      hostRequests: 1,
      hostRequestBytes: 128n,
      pendingWorkPolls: 10,
      hostRequestServicePolls: 1,
      outputServicePolls: 2,
      exitServicePolls: 1,
      timerServicePolls: 1,
      // Protocol 166: four slices; two ended for host attention.
      slices: {
        ends: { "action-budget": 0, deadline: 1, "compiled-module": 0, "interactive-output": 0, "host-attention": 2, boundary: 1, failure: 0 },
        hostAttention: { control: 1, "js-process": 1 }, attentionDeferrals: 3, inlinePendingWorkPolls: 4,
      },
      coreProfile: EMPTY_CORE_RUNTIME_PROFILE,
      backgroundCompile: {
        ...emptyBackgroundCompileProfile(),
        installMode: "deferred",
        submitted: 3,
        compiled: 2,
        inFlight: 1,
        peakInFlight: 2,
        compileMilliseconds: 1.5,
        latencyMilliseconds: 4.25,
        earlyYields: 1,
      },
      jitHealth: {
        state: "exhausted",
        reason: "code-memory",
        failures: { "code-memory": 2, "module-compilation": 0, "module-abi": 0 },
        firstFailure: {
          generation: 1,
          cacheKey: 0x1234n,
          reason: "code-memory",
          phase: "background-compile",
          errorName: "Error",
          message: "out of memory",
        },
        interpretedCompiles: 17,
        parkedCompiles: 40,
      },
      jitCode: {
        family: "spidermonkey",
        budgetBytes: 1024 * 1024 * 1024,
        units: 10,
        liveUnits: 6,
        deadUnits: 1,
        reclaimedUnits: 3,
        retainedBytes: 7 * 256 * 1024,
        deadBytes: 256 * 1024,
        reservedBytes: 128 * 1024,
        peakRetainedBytes: 9 * 256 * 1024,
        reclaimedBytes: 3 * 256 * 1024,
        refusals: { "live-budget": 0, "unreclaimed-code": 2 },
        collectionRequests: 4,
        collectionRequestBytes: 128 * 1024 * 1024,
      },
    } as const;
    expect(userspaceResponseDecoders["read-execution-profile"](profile)).toEqual(profile);
    const { slices } = profile;
    expect(() => userspaceResponseDecoders["read-execution-profile"]({ ...profile, slices: { ...slices, inlinePendingWorkPolls: 11 } })).toThrow(/do not reconcile/u);
    expect(() => userspaceResponseDecoders["read-execution-profile"]({ ...profile, slices: { ...slices, ends: { ...slices.ends, deadline: 2 } } })).toThrow(/do not reconcile/u);
    const { guestClockKernelTicks: _kernel, kernelAccountingModel: _model, ...oldClock } = profile;
    void _kernel;
    void _model;
    const archived = { ...oldClock, guestClockTicks: 2_560_030n };
    expect(() => userspaceResponseDecoders["read-execution-profile"](archived)).toThrow();
    expect(decodeUserspaceExecutionProfile(archived, "archive")).toMatchObject({
      guestClockKernelTicks: 0n, kernelAccountingModel: 0,
    });
    const normalizedArchive = decodeUserspaceExecutionProfile(archived, "archive");
    expect(decodeUserspaceExecutionProfile(normalizedArchive, "archive")).toEqual(normalizedArchive);
    expect(() => decodeUserspaceExecutionProfile({ ...archived, kernelAccountingModel: 0, guestClockKernelTicks: 1n }, "archive")).toThrow();
    for (const invalid of [
      { guestClockKernelTicks: 63n }, { kernelAccountingModel: 0 },
      { guestClockKernelTicks: undefined }, { kernelAccountingModel: undefined },
    ]) {
      expect(() => userspaceResponseDecoders["read-execution-profile"]({ ...profile, ...invalid })).toThrow();
    }
    const jit = { version: 1, runtimeKey: "profile:fixture", instructionProfiling: false, modules: [], droppedModules: 0, collidingModules: 0,
      operationSamples: [], droppedOperationSamples: 0, operationSampleTotal: 0, operationSamplePeriod: 64,
      interpreterReasons: emptyInterpreterReasonProfiles(), interpretedActionReasons: emptyInterpretedActionReasonProfiles() };
    expect(userspaceResponseDecoders["read-execution-profile"]({ ...profile, jit }).jit).toEqual(jit);
    expect(() => userspaceResponseDecoders["read-execution-profile"]({ ...profile, jit: { ...jit, version: 2 } })).toThrow();
    expect(() => userspaceResponseDecoders["read-execution-profile"]({ ...profile, jitTier: "tier1" }))
      .toThrow("Userspace");
    // Captures from before protocol 49 carry no background compile profile, captures from
    // before protocol 57 no JIT health, and captures from before protocol 58 no JIT code profile.
    // Captures from before protocol 166 carry no slice profile.
    const { backgroundCompile: _current, jitHealth: _health, jitCode: _code, jitTier: _tier, slices: _slices, ...legacyProfile } = profile;
    void _slices;
    void _current;
    void _health;
    void _code;
    void _tier;
    expect(userspaceResponseDecoders["read-execution-profile"](legacyProfile)).toMatchObject({
      slices: emptyUserspaceSliceProfile(),
      backgroundCompile: emptyBackgroundCompileProfile(),
      jitHealth: emptyJitHealthProfile(),
      jitCode: emptyJitCodeProfile(),
      jitTier: null,
    });
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      jitCode: { ...profile.jitCode, liveUnits: 7 },
    })).toThrow("JIT code profile does not reconcile");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      jitHealth: { ...profile.jitHealth, state: "disabled" },
    })).toThrow("JIT health profile does not reconcile");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      backgroundCompile: { ...profile.backgroundCompile, compiled: 3 },
    })).toThrow("background compile counters do not reconcile");
    expect(userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      coreProfile: { ...profile.coreProfile, syscallCpuClones: 2n, sysretCpuClones: 3n, replacementCommitCpuClones: 5n },
    })).toMatchObject({ coreProfile: { syscallCpuClones: 2n, sysretCpuClones: 3n, replacementCommitCpuClones: 5n } });
    const legacyCore = { ...profile.coreProfile };
    Reflect.deleteProperty(legacyCore, "syscallCpuClones");
    Reflect.deleteProperty(legacyCore, "sysretCpuClones");
    Reflect.deleteProperty(legacyCore, "replacementCommitCpuClones");
    expect(userspaceResponseDecoders["read-execution-profile"]({
      ...profile, coreProfile: { ...legacyCore, recordVersion: 20 },
    })).toMatchObject({ coreProfile: { recordVersion: 20, syscallCpuClones: 0n, sysretCpuClones: 0n, replacementCommitCpuClones: 0n } });
    expect(userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      timing: { kind: "disabled" },
    })).toMatchObject({ timing: { kind: "disabled" } });
    expect(userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      timing: { ...profile.timing, kind: "sampled", samples: 7 },
    })).toMatchObject({ timing: { kind: "sampled", samples: 7 } });
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      retiredInstructions: 31n,
    })).toThrow("retirement counters");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      translationJournalDrained: 7n,
    })).toThrow("journal counters");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      guestClockIdleTicks: 1n,
    })).toThrow("guest clock");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      prepareSamples: 11,
    })).toThrow("preparation counters");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      outputServicePolls: 11,
    })).toThrow("pending-work counters");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      guestKernelInstructions: 1n,
    })).toThrow("userspace invariant");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      jitChainHits: 89n,
    })).toThrow("chain counters");
    // A chain into a translation whose module is still compiling misses for that reason.
    const compiling = {
      ...profile,
      jitChainAttempts: 104n,
      coreProfile: { ...profile.coreProfile, jitChainMissingCompilePending: 4n },
    };
    expect(userspaceResponseDecoders["read-execution-profile"](compiling)).toEqual(compiling);
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      residentBytes: 4095n,
    })).toThrow("memory counters");
    expect(() => userspaceResponseDecoders["read-execution-profile"]({
      ...profile,
      extra: true,
    })).toThrow();
  });
});

it("validates process terminal resize without accepting stale or excess fields", () => {
  const request = { id: 1, version: PROTOCOL_VERSION, type: "resize-terminal", pid: 7, sessionId: 12, terminal: { columns: 132, rows: 43 } };
  expect(decodeUserspaceRequest(request)).toEqual(request);
  for (const invalid of [
    { terminal: { columns: 0, rows: 43 } }, { terminal: { columns: 1001, rows: 43 } },
    { terminal: { columns: 132, rows: 1.5 } }, { terminal: { columns: 132, rows: 43, extra: true } },
    { pid: 0 }, { version: PROTOCOL_VERSION - 1 }, { extra: true },
  ]) expect(() => decodeUserspaceRequest({ ...request, ...invalid })).toThrow();
});

it("requires generation-qualified input and adopts a saved native attachment through its own transport", () => {
  const base = { id: 1, version: PROTOCOL_VERSION, pid: 7 };
  for (const fields of [{ type: "stdin", data: new Uint8Array([1]) }, { type: "close-stdin" },
    { type: "resize-terminal", terminal: { columns: 80, rows: 24 } }, { type: "signal", signal: "INT" }]) {
    expect(() => decodeUserspaceRequest({ ...base, ...fields })).toThrow();
    expect(decodeUserspaceRequest({ ...base, ...fields, sessionId: 12 })).toMatchObject({ sessionId: 12 });
  }
  const channel = new MessageChannel();
  const attach = { id: 2, version: PROTOCOL_VERSION, type: "attach-process", attachmentKey: 12, port: channel.port1 };
  expect(decodeUserspaceRequest(attach)).toEqual(attach);
  expect(() => decodeUserspaceRequest({ ...attach, attachmentKey: 0 })).toThrow();
  channel.port1.close(); channel.port2.close();
});

it("preserves native stable identity independently of a rebound transport session",()=>{
 const reply={pid:7,sessionId:30,identityKey:12};
 expect(userspaceResponseDecoders["attach-process"](reply)).toEqual(reply);
 expect(()=>userspaceResponseDecoders.spawn({pid:7,sessionId:30})).toThrow();
 expect(()=>userspaceResponseDecoders.spawn({...reply,identityKey:0})).toThrow();
});
it("admits an explicit JS launch through the versioned process boundary", () => {
  const channel = new MessageChannel();
  try {
    const request = { id: 11, version: PROTOCOL_VERSION, type: "spawn-js", rootTreeSha256: "a".repeat(64), workspaceBaseSha256: "b".repeat(64), cpuProfile: "x86-64-v2", worker: "https://example.test/js.worker.js", arguments: ["input"], environment: ["A=B"], cwd: "/workspace", rootfs: new Uint8Array(4), port: channel.port1 };
    expect(decodeUserspaceRequest(request)).toEqual(request);
    expect(() => decodeUserspaceRequest({ ...request, version: PROTOCOL_VERSION - 1 })).toThrow();
    expect(() => decodeUserspaceRequest({ ...request, extra: true })).toThrow();
  } finally { channel.port1.close(); channel.port2.close(); }
});

it("subscribes to acceleration notices with an exact request and a transferred port", () => {
  expect(decodeUserspaceRequest({ id: 3, version: PROTOCOL_VERSION, type: "acceleration-notices" })).toEqual({ id: 3, version: PROTOCOL_VERSION, type: "acceleration-notices" });
  expect(() => decodeUserspaceRequest({ id: 3, version: PROTOCOL_VERSION, type: "acceleration-notices", pid: 1 })).toThrow();
  const { port1, port2 } = new MessageChannel();
  expect(userspaceResponseDecoders["acceleration-notices"](port1)).toBe(port1);
  expect(() => userspaceResponseDecoders["acceleration-notices"]({})).toThrow();
  port1.close(); port2.close();
  const notice = { pid: 42, session: 40, kind: "unqualified-addon", detail: "sharp.node" };
  expect(decodeAccelerationNoticeMessage({ version: PROTOCOL_VERSION, notice })).toMatchObject(notice);
  for (const message of [{ version: PROTOCOL_VERSION - 1, notice }, { version: PROTOCOL_VERSION, notice, extra: 1 }, { version: PROTOCOL_VERSION }, "notice"]) {
    expect(() => decodeAccelerationNoticeMessage(message)).toThrow();
  }
});
