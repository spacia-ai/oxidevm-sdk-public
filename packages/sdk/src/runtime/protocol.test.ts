import { describe, expect, it } from "vitest";
import { CORE_API_VERSION } from "./core-abi.js";

import { VMError } from "./errors.js";
import { JIT_REGION_MAX_INSTRUCTIONS } from "./jit-cache.js";
import { emptyJitHealthProfile } from "./protocol/system-trace-jit-health.js";
import { emptySystemHostAttentionProfile } from "./protocol/system-attention.js";
import { emptyJitCodeProfile } from "./protocol/system-trace-jit-code.js";
import {
  decodeControlIncoming,
  decodeCoreProbeResult,
  decodeGuestProcessPortAck,
  decodeGuestProcessWireEvent,
  decodeSnapshotRef,
  decodeSystemExecutionPortAck,
  decodeSystemExecutionWireEvent,
  decodeSystemSliceResult,
  decodeSystemProbeResult,
  controlResponseDecoders,
  PROTOCOL_VERSION,
  validateSnapshotLabel,
} from "./protocol.js";

const state = {
  rax: 42n,
  rcx: 0n,
  rdx: 0n,
  rbx: 0n,
  rsp: 0n,
  rbp: 0n,
  rsi: 0n,
  rdi: 0n,
  r8: 0n,
  r9: 0n,
  r10: 0n,
  r11: 0n,
  r12: 0n,
  r13: 0n,
  r14: 0n,
  r15: 0n,
  rip: 17n,
  rflags: 2n,
  mode: "long",
  cpl: 0,
};

const runtime = {
  profile: "x86-64-v3",
  jitState: "active",
  retiredInstructions: 100_000n,
  jitInstructions: 99_000n,
  interpretedInstructions: 1_000n,
  cacheHits: 900n,
  moduleLoads: 100n,
  compileSamples: 100,
  compileP95Milliseconds: 8,
  compileMaximumMilliseconds: 21,
  guardExits: 2n,
  evictions: 1n,
  cacheEntries: 99,
  cacheBytes: 1_048_576,
  cacheLimitBytes: 256 * 1024 * 1024,
};

describe("worker protocol decoders", () => {
  it("decodes the complete v3 diagnostic result", () => {
    expect(
      decodeCoreProbeResult({
        apiVersion: CORE_API_VERSION,
        exit: { kind: "halted", steps: 3n },
        state,
      }),
    ).toEqual({
      apiVersion: CORE_API_VERSION,
      exit: { kind: "halted", steps: 3n },
      state,
    });
  });

  it("decodes structured architectural exceptions", () => {
    const result = decodeCoreProbeResult({
      apiVersion: CORE_API_VERSION,
      exit: {
        kind: "exception",
        steps: 1n,
        exception: {
          vector: { name: "#PF", number: 14 },
          class: "fault",
          errorCode: 5,
          faultAddress: 0x1234n,
          instructionRip: 0x1000n,
        },
      },
      state,
    });
    expect(result.exit.kind).toBe("exception");
    if (result.exit.kind === "exception") {
      expect(result.exit.exception.faultAddress).toBe(0x1234n);
    }
  });

  it.each([
    {
      apiVersion: 1,
      exit: { kind: "halted", steps: 3n },
      state,
    },
    {
      apiVersion: CORE_API_VERSION,
      exit: { kind: "halted", steps: 3n, extra: true },
      state,
    },
    {
      apiVersion: CORE_API_VERSION,
      exit: { kind: "halted", steps: 3n },
      state: { ...state, cpl: 4 },
    },
  ])("rejects malformed diagnostic records", (value) => {
    expect(() => decodeCoreProbeResult(value)).toThrow(VMError);
  });

  it("rejects extra request fields before dispatch", () => {
    const channel = new MessageChannel();
    expect(() =>
      decodeControlIncoming({
        id: 1,
        version: PROTOCOL_VERSION,
        type: "dispose",
        extra: true,
      }),
    ).toThrow(VMError);
    expect(
      decodeControlIncoming({
        id: 1,
        version: PROTOCOL_VERSION,
        type: "initialize",
        coreWasmUrl: "/oxidevm_core.wasm",
        sharedCoreWasmUrl: "/oxidevm_core_shared.wasm",
        workspaceId: "default",
        memoryMiB: 1536,
        vcpus: 2,
        snapshotPort: channel.port1,
      }),
    ).toMatchObject({ type: "initialize", workspaceId: "default" });
    channel.port1.close();
    channel.port2.close();
  });

  it("decodes the closed workspace-manifest control operation", () => {
    const request = {
      id: 7,
      version: PROTOCOL_VERSION,
      type: "agent-workspace-manifest",
    } as const;
    expect(decodeControlIncoming(request)).toEqual(request);
    expect(() => decodeControlIncoming({ ...request, extra: true })).toThrow(VMError);
    expect(controlResponseDecoders["agent-workspace-manifest"](new Uint8Array([1, 2])))
      .toEqual(new Uint8Array([1, 2]));
  });

  it("strictly validates snapshot references and labels", () => {
    const snapshot = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    expect(decodeSnapshotRef(snapshot)).toEqual(snapshot);
    expect(validateSnapshotLabel("checkpoint")).toBe("checkpoint");
    expect(() => decodeSnapshotRef({ ...snapshot, id: "../escape" })).toThrow(VMError);
    expect(() => decodeSnapshotRef({ ...snapshot, extra: true })).toThrow(VMError);
    expect(() => validateSnapshotLabel("x".repeat(257))).toThrow(VMError);
  });

  it("strictly decodes full-system requests and console results", () => {
    const request = {
      id: 1,
      version: PROTOCOL_VERSION,
      type: "run-system-probe",
      memoryMiB: 256,
      kernel: new Uint8Array([1]),
      commandLine: "console=ttyS0",
      maximumSteps: 1_000,
    } as const;
    expect(decodeControlIncoming(request)).toEqual(request);
    expect(() =>
      decodeControlIncoming({ ...request, memoryMiB: 8 }),
    ).toThrow(VMError);
    expect(() =>
      decodeControlIncoming({ ...request, extra: true }),
    ).toThrow(VMError);

    expect(
      decodeSystemProbeResult({
        apiVersion: CORE_API_VERSION,
        exit: { kind: "step-limit", steps: 1_000n },
        state,
        console: new Uint8Array([79, 75]),
      }),
    ).toEqual({
      apiVersion: CORE_API_VERSION,
      exit: { kind: "step-limit", steps: 1_000n },
      state,
      console: new Uint8Array([79, 75]),
    });

    const boot = {
      id: 2,
      version: PROTOCOL_VERSION,
      type: "boot-system",
      memoryMiB: 256,
      kernel: new Uint8Array([1]),
      commandLine: "console=hvc0",
    } as const;
    expect(decodeControlIncoming(boot)).toEqual(boot);
    expect(
      decodeControlIncoming({
        id: 18,
        version: PROTOCOL_VERSION,
        type: "configure-system-trace",
        capacity: 32_768,
        interpreterOnly: false,
        interpretedSemantics: [],
        interpretedRipRanges: [],
        checkpointPolicy: "faults-only",
      }),
    ).toMatchObject({
      type: "configure-system-trace",
      checkpointPolicy: "faults-only",
    });
    expect(() =>
      decodeControlIncoming({
        id: 18,
        version: PROTOCOL_VERSION,
        type: "configure-system-trace",
        capacity: 32_768,
        interpreterOnly: false,
        interpretedSemantics: [],
        interpretedRipRanges: [],
        checkpointPolicy: "anything",
      }),
    ).toThrow(VMError);
    expect(
      decodeControlIncoming({
        id: 3,
        version: PROTOCOL_VERSION,
        type: "run-system-slice",
        maximumSteps: 100_000,
      }),
    ).toMatchObject({ type: "run-system-slice", maximumSteps: 100_000 });
    expect(
      decodeControlIncoming({
        id: 4,
        version: PROTOCOL_VERSION,
        type: "write-system-console",
        data: new Uint8Array([13]),
      }),
    ).toMatchObject({ type: "write-system-console" });
    expect(() =>
      decodeControlIncoming({
        id: 5,
        version: PROTOCOL_VERSION,
        type: "write-system-console",
        data: new Uint8Array(),
      }),
    ).toThrow(VMError);
    expect(
      decodeSystemSliceResult({
        apiVersion: CORE_API_VERSION,
        exit: { kind: "step-limit", steps: 100_000n },
        state,
        cpus: [state],
        console: new Uint8Array([35, 32]),
        runtime,
      }),
    ).toEqual({
      apiVersion: CORE_API_VERSION,
      exit: { kind: "step-limit", steps: 100_000n },
      state,
      cpus: [state],
      console: new Uint8Array([35, 32]),
      runtime,
    });
    expect(() =>
      decodeSystemSliceResult({
        apiVersion: CORE_API_VERSION,
        exit: { kind: "step-limit", steps: 100_000n },
        state,
        cpus: [state],
        console: new Uint8Array(),
        runtime: { ...runtime, retiredInstructions: 99_999n },
      }),
    ).toThrow(VMError);
    expect(() =>
      decodeSystemSliceResult({
        apiVersion: CORE_API_VERSION,
        exit: { kind: "step-limit", steps: 100_000n },
        state,
        cpus: [state],
        console: new Uint8Array(),
        runtime: { ...runtime, compileP95Milliseconds: 22 },
      }),
    ).toThrow(VMError);
    expect(() =>
      decodeSystemSliceResult({
        apiVersion: CORE_API_VERSION,
        exit: { kind: "step-limit", steps: 100_000n },
        state,
        cpus: [state],
        console: new Uint8Array(),
        runtime: { ...runtime, compileSamples: 99 },
      }),
    ).toThrow(VMError);
    expect(() =>
      decodeSystemSliceResult({
        apiVersion: CORE_API_VERSION,
        exit: { kind: "step-limit", steps: 100_000n },
        state,
        cpus: [state],
        console: new Uint8Array(),
        runtime: { ...runtime, extra: true },
      }),
    ).toThrow(VMError);
  });

  it("strictly decodes continuous system sessions", () => {
    const channel = new MessageChannel();
    expect(
      decodeControlIncoming({
        id: 6,
        version: PROTOCOL_VERSION,
        type: "start-system",
        sessionId: 4,
        port: channel.port1,
      }),
    ).toMatchObject({ type: "start-system", sessionId: 4 });
    expect(() =>
      decodeControlIncoming({
        id: 7,
        version: PROTOCOL_VERSION,
        type: "start-system",
        sessionId: 4,
        port: {},
      }),
    ).toThrow(VMError);
    expect(
      decodeControlIncoming({
        id: 8,
        version: PROTOCOL_VERSION,
        type: "pause-system",
        sessionId: 4,
      }),
    ).toMatchObject({ type: "pause-system", sessionId: 4 });

    expect(
      decodeSystemExecutionWireEvent({
        version: PROTOCOL_VERSION,
        sessionId: 4,
        sequence: 1,
        type: "console",
        data: new Uint8Array([35, 32]),
      }),
    ).toMatchObject({ type: "console", sessionId: 4, sequence: 1 });
    expect(
      decodeSystemExecutionWireEvent({
        version: PROTOCOL_VERSION,
        sessionId: 4,
        sequence: 2,
        type: "telemetry",
        runtime,
        workerTimestamp: 42.5,
      }),
    ).toMatchObject({ type: "telemetry", workerTimestamp: 42.5 });
    expect(() =>
      decodeSystemExecutionWireEvent({
        version: PROTOCOL_VERSION,
        sessionId: 4,
        sequence: 3,
        type: "telemetry",
        runtime,
        workerTimestamp: Number.NaN,
      }),
    ).toThrow(VMError);
    expect(
      decodeSystemExecutionPortAck({
        version: PROTOCOL_VERSION,
        sessionId: 4,
        type: "console-ack",
        sequence: 1,
      }),
    ).toEqual({
      version: PROTOCOL_VERSION,
      sessionId: 4,
      type: "console-ack",
      sequence: 1,
    });
    expect(() =>
      decodeSystemExecutionPortAck({
        version: PROTOCOL_VERSION,
        sessionId: 4,
        type: "console-ack",
        sequence: 1,
        extra: true,
      }),
    ).toThrow(VMError);
    channel.port1.close();
    channel.port2.close();
  });

  it("strictly decodes bounded system traces", () => {
    const registers = {
      rax: 1n,
      rcx: 2n,
      rdx: 3n,
      rbx: 4n,
      rsp: 5n,
      rbp: 6n,
      rsi: 7n,
      rdi: 8n,
      r8: 9n,
      r9: 10n,
      r10: 11n,
      r11: 12n,
      r12: 13n,
      r13: 14n,
      r14: 15n,
      r15: 16n,
    };
    const traceState = {
      rip: 0x1000n,
      rflags: 2n,
      cr3: 0x2000n,
      cpl: 3,
      mode: "long",
      registers,
    };
    const jitContext = {
      cr3: 0x2000n,
      forceExit: false,
      entryIndex: 0,
      readEpoch: 1,
      writeEpoch: 1n,
      lastDispatchSlot: 5,
      dispatchEpoch: 2n,
      pendingWrites: 0n,
    };
    const snapshot = {
      schemaVersion: 6,
      executionMode: "semantic-quarantine",
      interpretedSemantics: [228],
      interpretedRipRanges: [{ start: 0x1000n, end: 0x2000n }],
      applicationSampleRate: 16,
      runtimeKey: "a".repeat(64),
      capturedAt: 42.5,
      trigger: "guest-process-exit",
      capacity: 16,
      dropped: 4,
      runtime,
      profile: {
        worker: {
          jitBatches: 1,
          jitMilliseconds: 0.5,
          interpreterBatches: 1,
          interpreterMilliseconds: 0.25,
          compileMilliseconds: 1.25,
        },
        disk: {
          enabled: true,
          requests: 3,
          failures: 0,
          reads: 1,
          readBytes: 4096,
          writes: 1,
          writtenBytes: 4096,
          zeroes: 0,
          zeroedBytes: 0,
          discards: 0,
          discardedBytes: 0,
          flushes: 1,
          waitMilliseconds: 2,
          maximumWaitMilliseconds: 1,
        },
        agent: {
          requests: 2,
          spawnedProcesses: 1,
          stdinBytes: 0,
          stdoutBytes: 64,
          stderrBytes: 0,
        },
      },
      state: traceState,
      consoleTail: "guest failure",
      events: [
        {
          kind: "compile",
          sequence: 1,
          workerTimestamp: 40,
          startRip: 0x1000n,
          cacheKey: 7n,
          dispatchSlot: 4,
          moduleBytes: 128,
          compileMilliseconds: 1.25,
          instructions: [{ rip: 0x1000n, semantic: 12, retired: 1 }],
        },
        {
          kind: "jit",
          sequence: 2,
          workerTimestamp: 41,
          before: traceState,
          after: { ...traceState, rip: 0x1001n },
          cacheKey: 7n,
          cacheHit: true,
          dispatchSlot: 4,
          lastDispatchSlot: 5,
          budget: 64,
          steps: 1n,
          durationMilliseconds: 0.5,
          exit: "budget",
          instructions: [{ rip: 0x1000n, semantic: 12, retired: 1 }],
          contextBefore: { ...jitContext, lastDispatchSlot: null },
          contextBoundary: { ...jitContext, pendingWrites: 1n },
          contextAfter: jitContext,
        },
        {
          kind: "interpreter",
          sequence: 3,
          workerTimestamp: 42,
          before: { ...traceState, rip: 0x1001n },
          after: { ...traceState, rip: 0x1002n },
          budget: 1,
          steps: 1n,
          durationMilliseconds: 0.25,
          reason: "guard",
          exit: "step-limit",
        },
      ],
    } as const;
    const decodedLegacyTrace =
      controlResponseDecoders["read-system-trace"](snapshot);
    expect(decodedLegacyTrace).toMatchObject(snapshot);
    const regionalInstructions = Array.from({ length: 256 }, (_, index) => ({
      rip: 0x1000n + BigInt(index),
      semantic: 12,
      retired: 1,
    }));
    expect(
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        events: [
          { ...snapshot.events[0], instructions: regionalInstructions },
          ...snapshot.events.slice(1),
        ],
      }).events[0],
    ).toMatchObject({ instructions: regionalInstructions });
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        events: [
          {
            ...snapshot.events[0],
            instructions: Array.from(
              { length: JIT_REGION_MAX_INSTRUCTIONS + 1 },
              () => regionalInstructions[0],
            ),
          },
          ...snapshot.events.slice(1),
        ],
      }),
    ).toThrow(VMError);
    expect(
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          cacheBytes: 96 * 1024 * 1024,
          cacheLimitBytes: 128 * 1024 * 1024,
        },
      }).runtime.cacheLimitBytes,
    ).toBe(128 * 1024 * 1024);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          cacheBytes: 129 * 1024 * 1024,
          cacheLimitBytes: 128 * 1024 * 1024,
        },
      }),
    ).toThrow(VMError);
    expect(decodedLegacyTrace.profile.worker.interpreterReasons.guard).toEqual(
      { batches: 0, instructions: 0n, milliseconds: 0 },
    );
    const currentSnapshot = {
      ...snapshot,
      schemaVersion: 7,
      profile: {
        ...snapshot.profile,
        worker: {
          ...snapshot.profile.worker,
          interpreterReasons: {
            admission: {
              batches: 0,
              instructions: 0n,
              milliseconds: 0,
            },
            compiling: {
              batches: 0,
              instructions: 0n,
              milliseconds: 0,
            },
            degraded: {
              batches: 0,
              instructions: 0n,
              milliseconds: 0,
            },
            guard: {
              batches: 1,
              instructions: 1n,
              milliseconds: 0.25,
            },
            quarantine: {
              batches: 0,
              instructions: 0n,
              milliseconds: 0,
            },
          },
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](currentSnapshot).profile
        .worker.interpreterReasons,
    ).toEqual({
      admission: currentSnapshot.profile.worker.interpreterReasons.admission,
      // Schema 48 adds the code-budget reason; earlier evidence has none.
      "code-budget": { batches: 0, instructions: 0n, milliseconds: 0 },
      degraded: currentSnapshot.profile.worker.interpreterReasons.degraded,
      guard: currentSnapshot.profile.worker.interpreterReasons.guard,
      quarantine: currentSnapshot.profile.worker.interpreterReasons.quarantine,
    });
    expect(
      controlResponseDecoders["read-system-trace"](currentSnapshot).profile
        .worker.jitInstructions,
    ).toBe(0n);
    const profiledSnapshot = {
      ...currentSnapshot,
      schemaVersion: 8,
      profile: {
        ...currentSnapshot.profile,
        worker: {
          ...currentSnapshot.profile.worker,
          jitInstructions: 4_096n,
          jitCacheHits: 63n,
          jitGuardExits: 1n,
          compileRequests: 2,
          compileTraces: 8,
          compileBytes: 65_536,
          bundleEvictions: 3,
          peakCacheBytes: 96 * 1024 * 1024,
        },
      },
    } as const;
    const decodedProfiled =
      controlResponseDecoders["read-system-trace"](profiledSnapshot);
    expect(decodedProfiled.profile.worker).toMatchObject({
      synchronousCompiles: 2,
      compileModules: 8,
      recompiledModules: 0,
      moduleEvictions: 3,
    });
    const churnSnapshot = {
      ...profiledSnapshot,
      schemaVersion: 9,
      profile: {
        ...profiledSnapshot.profile,
        worker: {
          ...profiledSnapshot.profile.worker,
          firstCompileTraces: 5,
          repeatCompileTraces: 3,
          evictedTraces: 7,
        },
      },
    } as const;
    const decodedChurn =
      controlResponseDecoders["read-system-trace"](churnSnapshot);
    expect(decodedChurn.profile.worker).toMatchObject({
      firstCompileModules: 5,
      recompiledModules: 3,
    });
    expect(
      decodedChurn.profile.worker.evictionReasons["byte-capacity"].modules,
    ).toBe(0);
    const attributedSnapshot = {
      ...churnSnapshot,
      schemaVersion: 10,
      profile: {
        ...churnSnapshot.profile,
        worker: {
          ...churnSnapshot.profile.worker,
          evictionReasons: {
            "byte-capacity": { bundles: 2, traces: 5, bytes: 50_000 },
            "dispatch-slot": { bundles: 0, traces: 0, bytes: 0 },
            "duplicate-install": { bundles: 0, traces: 0, bytes: 0 },
            "stale-registration": { bundles: 1, traces: 2, bytes: 15_536 },
            "trace-reconfiguration": { bundles: 0, traces: 0, bytes: 0 },
          },
        },
      },
    } as const;
    const emptyCoreProfile = {
      enabled: false,
      decodeCacheHits: 0n,
      decodeCacheMisses: 0n,
      decodeCacheEmpty: 0n,
      decodeCacheTagMismatches: 0n,
      decodeMappingFastHits: 0n,
      decodeMappingRevalidations: 0n,
      decodeMappingMismatches: 0n,
      decodeMappingInvalidationChanges: 0n,
      decodeMappingCr3Changes: 0n,
      decodeMappingPolicyChanges: 0n,
      decodeGenerationFastHits: 0n,
      decodeGenerationChecks: 0n,
      decodeGenerationMismatches: 0n,
      decodedBytes: 0n,
      tlbHits: 0n,
      tlbMisses: 0n,
      tlbProbeHits: 0n,
      tlbProbeMisses: 0n,
      tlbInvlpg: 0n,
      tlbInvpcidIndividual: 0n,
      tlbInvpcidSingleContext: 0n,
      tlbInvpcidAllNonGlobal: 0n,
      tlbInvpcidAll: 0n,
      jitChainAttempts: 0n,
      jitChainHits: 0n,
      jitChainMissingCoverage: 0n,
      jitChainMissingCache: 0n,
      jitChainMissingDispatchSlot: 0n,
      jitChainMissingEntry: 0n,
      jitChainInvalidCode: 0n,
      jitChainContextFailures: 0n,
      jitCodeWritePages: 0n,
      jitCodeWriteInvalidations: 0n,
      jitCacheReplacements: 0n,
      jitCacheCapacityEvictions: 0n,
      jitDispatchSlotRebindings: 0n,
      jitAdmissionChecks: 0n,
      jitAdmissionRejections: 0n,
      jitCandidatePrepareFailures: 0n,
      jitCandidateBlocked: 0n,
      jitCandidateEmitFailures: 0n,
      jitCandidateCompiles: 0n,
      jitCacheReuseHits: 0n,
      jitCacheReusedTranslations: 0n,
      jitCacheEightHitTranslations: 0n,
      jitCacheThirtyTwoHitTranslations: 0n,
      jitChainCoverageTargets: 0n,
      jitChainCoverageEightMissTargets: 0n,
      jitChainCoverageThirtyTwoMissTargets: 0n,
      jitChainCoverageSixtyFourMissTargets: 0n,
      jitChainCoverageAdmissionResets: 0n,
      jitChainCoverageAdmissionResetTargets: 0n,
      workload: {
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
      },
    } as const;
    const decodedAttributed =
      controlResponseDecoders["read-system-trace"](attributedSnapshot);
    expect(decodedAttributed.profile.worker).toMatchObject({
      core: { enabled: false },
      jitChainTransitions: 0n,
      synchronousCompiles: 2,
      compileModules: 8,
      moduleEvictions: 3,
      evictionReasons: {
        "byte-capacity": { modules: 2, bytes: 50_000 },
        "stale-registration": { modules: 1, bytes: 15_536 },
      },
    });
    const chainedSnapshot = {
      ...attributedSnapshot,
      schemaVersion: 11,
      profile: {
        ...attributedSnapshot.profile,
        worker: {
          ...attributedSnapshot.profile.worker,
          jitChainTransitions: 11n,
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](chainedSnapshot).profile
        .worker.jitChainTransitions,
    ).toBe(11n);
    const profiledPipelineSnapshot = {
      ...chainedSnapshot,
      schemaVersion: 12,
      profile: {
        ...chainedSnapshot.profile,
        worker: {
          ...chainedSnapshot.profile.worker,
          prepareCalls: 4_096,
          prepareSamples: 16,
          prepareSampleMilliseconds: 2,
          executionLoopCalls: 128,
          executionLoopMilliseconds: 512,
          taskYields: 127,
          taskYieldMilliseconds: 8,
          consoleAckWaits: 4,
          consoleAckWaitMilliseconds: 2,
          agentTurnWaits: 16,
          agentTurnWaitMilliseconds: 3,
          compilerMilliseconds: 10,
          instantiateMilliseconds: 3,
          installMilliseconds: 1,
          compiledInstructions: 512n,
          maximumCandidateInstructions: 128,
          maximumCandidateBytes: 65_536,
          maximumBundleTraces: 16,
          maximumBundleBytes: 524_288,
          peakPendingTraces: 16,
          peakPendingBytes: 262_144,
          peakLiveBundles: 32,
          peakLiveTraces: 256,
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](
        profiledPipelineSnapshot,
      ).profile.worker,
    ).toMatchObject({
      prepareCalls: 4_096,
      executionLoopCalls: 128,
      compiledInstructions: 512n,
      maximumCandidateInstructions: 128,
      maximumCandidateBytes: 65_536,
      peakLiveModules: 32,
    });
    const coreProfiledSnapshot = {
      ...profiledPipelineSnapshot,
      schemaVersion: 19,
      profile: {
        ...profiledPipelineSnapshot.profile,
        worker: {
          ...profiledPipelineSnapshot.profile.worker,
          core: {
            ...emptyCoreProfile,
            enabled: true,
            decodeCacheHits: 10n,
            decodeCacheMisses: 2n,
            tlbHits: 30n,
            tlbMisses: 1n,
            workload: {
              samplePeriod: 4_096,
              instructionAttempts: 1n,
              instructionCommits: 1n,
              siteSamples: 0n,
              droppedSiteSamples: 0n,
              unmappedAdmissionSites: 0n,
              semanticAttempts: [1n],
              semanticCommits: [1n],
              sites: [],
              admissionSites: [
                {
                  rip: 0x5_000n,
                  physicalFrame: 0x13_000n,
                  generation: 10n,
                  firstObservation: 11n,
                  lastObservation: 19n,
                  entryOffset: 0x45,
                  visits: 0,
                  requiredVisits: 256,
                  codeAttributes: 0x209b,
                  mode: 3,
                  cpl: 3,
                  profile: 2,
                  blocked: false,
                  admitted: true,
                  cached: true,
                },
              ],
            },
          },
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](coreProfiledSnapshot)
        .profile.worker.core,
    ).toMatchObject({
      enabled: true,
      decodeCacheHits: 10n,
      decodeCacheMisses: 2n,
      tlbHits: 30n,
      tlbMisses: 1n,
    });
    const diskProfiledSnapshot = {
      ...coreProfiledSnapshot,
      schemaVersion: 20,
      profile: {
        ...coreProfiledSnapshot.profile,
        disk: {
          ...coreProfiledSnapshot.profile.disk,
          maximumQueueDepth: 2,
          busyReturns: 0,
          maximumInFlight: 1,
          delayedFailures: 1,
          backendFailures: 1,
          protocolFailures: 0,
          timeoutFailures: 0,
          stickyFailure: { sequence: 7, reason: "backend" },
          failures: 1,
        },
      },
    } as const;
    const decodedDiskProfiled =
      controlResponseDecoders["read-system-trace"](diskProfiledSnapshot);
    expect(decodedDiskProfiled.profile.disk).toEqual(
      diskProfiledSnapshot.profile.disk,
    );
    // Decoding normalises the schema-36 interpreted-action reasons, schema 44's background
    // compile profile, schema 47's JIT health, schema 48's JIT code profile and code-budget
    // reasons and schema 54's host attention to empty records for older traces; an older wire
    // fixture must not carry them back.
    const {
      interpretedActionReasons: normalisedInterpretedActions,
      backgroundCompile,
      jitHealth,
      jitCode,
      hostAttention,
      evictionReasons: { "code-budget": codeBudgetEvictions, ...olderEvictionReasons },
      interpreterReasons: { "code-budget": codeBudgetInterpreter, ...olderInterpreterReasons },
      ...olderWorkerFields
    } = decodedDiskProfiled.profile.worker;
    const olderWorker = {
      ...olderWorkerFields,
      evictionReasons: olderEvictionReasons,
      interpreterReasons: olderInterpreterReasons,
    };
    expect(Object.values(normalisedInterpretedActions).every(profile => profile.batches === 0) && backgroundCompile.submitted === 0).toBe(true);
    expect(jitHealth).toEqual(emptyJitHealthProfile());
    expect(jitCode).toEqual(emptyJitCodeProfile());
    expect(hostAttention).toEqual(emptySystemHostAttentionProfile());
    expect(codeBudgetEvictions).toEqual({ modules: 0, bytes: 0 });
    expect(codeBudgetInterpreter).toEqual({ batches: 0, instructions: 0n, milliseconds: 0 });
    const currentTrace = {
      ...decodedDiskProfiled,
      schemaVersion: 21,
      events: decodedDiskProfiled.events.map((event) => {
        if (!("instructions" in event)) return event;
        return {
          ...event,
          instructions: event.instructions.map(({ instructionForm, ...instruction }) => {
            void instructionForm;
            return instruction;
          }),
        };
      }),
      profile: {
        ...decodedDiskProfiled.profile,
        worker: {
          ...olderWorker,
          synchronousCompiles: 8,
          synchronousCompileP95Milliseconds: 2,
          synchronousCompileMaximumMilliseconds: 3,
          segmentGuards: 8,
          stickyJitFailure: {
            generation: 3,
            cacheKey: 9n,
            reason: "module-abi",
          },
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](currentTrace),
    ).toMatchObject(currentTrace);
    const exactOptimizationTrace = {
      ...currentTrace,
      schemaVersion: 23,
      profile: {
        ...currentTrace.profile,
        worker: {
          ...currentTrace.profile.worker,
          moduleEvictions: 5,
          dispatchVictimAge: {
            "0-15": 1,
            "16-63": 1,
            "64-255": 0,
            "256-1023": 0,
            "1024+": 0,
          },
          dispatchSubsequentRecompiles: 1,
          dispatchRecompileReuseDistance: {
            "0-15": 0,
            "16-63": 1,
            "64-255": 0,
            "256-1023": 0,
            "1024+": 0,
          },
          dispatchEvictionTrackingDropped: 0,
          evictionReasons: {
            ...currentTrace.profile.worker.evictionReasons,
            "dispatch-slot": { modules: 2, bytes: 16_384 },
          },
          core: {
            ...currentTrace.profile.worker.core,
            recordVersion: 11,
            jitChainAttempts: 7n,
            jitChainHits: 7n,
            jitDispatchMissTag: 7n,
            jitRegionCandidates: 5n,
            jitRegionStopSuccessorNotReady: 3n,
            workload: {
              ...currentTrace.profile.worker.core.workload,
              cacheConflictCapacity: 4_096,
              droppedCacheConflicts: 0n,
              cacheConflicts: [
                {
                  kind: "dispatch",
                  identity: 0x4_000n,
                  addressSpace: 0x10_000n,
                  conflicts: 7n,
                },
              ],
            },
          },
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](exactOptimizationTrace),
    ).toMatchObject({
      schemaVersion: 23,
      profile: {
        worker: {
          dispatchSubsequentRecompiles: 1,
          core: {
            jitRegionCandidates: 5n,
            jitRegionStopSuccessorNotReady: 3n,
            workload: { cacheConflicts: [{ sampledConflicts: 7n }] },
          },
        },
      },
    });
    const exactPairTrace = {
      ...controlResponseDecoders["read-system-trace"](exactOptimizationTrace),
      schemaVersion: 24,
      events: exactOptimizationTrace.events,
      profile: {
        ...exactOptimizationTrace.profile,
        worker: {
          ...exactOptimizationTrace.profile.worker,
          dormantJitReactivations: 2,
          dormantJitReactivationBytes: 16,
          core: {
            ...exactOptimizationTrace.profile.worker.core,
            recordVersion: 12,
            jitReadCacheHits: 11n,
            jitWriteCacheHits: 13n,
            jitDispatchSlotClearEntriesScanned: 65_536n,
            jitDispatchSlotClearEntriesCleared: 1n,
            workload: {
              ...exactOptimizationTrace.profile.worker.core.workload,
              cacheConflictSamplePeriod: 64,
              cacheConflictSamples: 1n,
              cacheConflicts: [{
                kind: "dispatch",
                index: 19,
                incomingTag: 0x4_000n,
                displacedTag: 0x5_000n,
                addressSpace: 0x10_000n,
                sampledConflicts: 1n,
                alternations: 0n,
                reuseDistance: {
                  "0-15": 0n,
                  "16-63": 0n,
                  "64-255": 0n,
                  "256-1023": 0n,
                  "1024+": 0n,
                },
                pairAvailability: "measured",
              }],
            },
          },
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](exactPairTrace),
    ).toMatchObject({
      schemaVersion: 24,
      profile: {
        worker: {
          dormantJitReactivations: 2,
          core: {
            jitReadCacheHits: 11n,
            jitDispatchSlotClearEntriesScanned: 65_536n,
            workload: {
              cacheConflictSamplePeriod: 64,
              cacheConflicts: [{ displacedTag: 0x5_000n }],
            },
          },
        },
      },
    });
    const regionalModuleInstructions = Array.from({ length: 512 }, (_, index) => ({
      rip: 0x10_000n + BigInt(index),
      semantic: 12,
      retired: 1,
      instructionForm: null,
    }));
    const currentJitTrace = {
      ...exactPairTrace,
      schemaVersion: 25,
      jitModules: [{
        profileModuleId: "0123456789abcdef",
        cacheKey: 7n,
        instructions: regionalModuleInstructions,
        operations: [],
        plan: {
          initialStateMask: 0n,
          dirtyStateMask: 0n,
          stateMaterializationBoundaries: 0,
          segmentGuards: 0,
        },
      }],
      droppedJitModules: 0,
      collidingJitModules: 0,
      profile: {
        ...exactPairTrace.profile,
        worker: {
          ...exactPairTrace.profile.worker,
          core: {
            ...exactPairTrace.profile.worker.core,
            recordVersion: 13,
            jitReadVictimHits: 0n,
            jitWriteVictimHits: 0n,
          },
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](currentJitTrace).jitModules,
    ).toHaveLength(1);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...currentJitTrace,
        jitModules: [{
          ...currentJitTrace.jitModules[0],
          instructions: Array.from(
            { length: JIT_REGION_MAX_INSTRUCTIONS + 1 },
            () => regionalModuleInstructions[0],
          ),
        }],
      }),
    ).toThrow(VMError);
    const expandedDirectCacheTrace = {
      ...exactPairTrace,
      profile: {
        ...exactPairTrace.profile,
        worker: {
          ...exactPairTrace.profile.worker,
          core: {
            ...exactPairTrace.profile.worker.core,
            workload: {
              ...exactPairTrace.profile.worker.core.workload,
              cacheConflicts: [{
                ...exactPairTrace.profile.worker.core.workload.cacheConflicts[0],
                kind: "read",
                index: 65_535,
              }],
            },
          },
        },
      },
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](expandedDirectCacheTrace)
        .profile.worker.core.workload.cacheConflicts[0],
    ).toMatchObject({ kind: "read", index: 65_535 });
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...currentTrace,
        profile: {
          ...currentTrace.profile,
          worker: {
            ...currentTrace.profile.worker,
            synchronousCompiles: 7,
          },
        },
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...currentTrace,
        profile: {
          ...currentTrace.profile,
          worker: {
            ...currentTrace.profile.worker,
            dirtyStateMask: 1n << 63n,
          },
        },
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...currentTrace,
        profile: {
          ...currentTrace.profile,
          worker: {
            ...currentTrace.profile.worker,
            persistentCache: {},
          },
        },
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...diskProfiledSnapshot,
        profile: {
          ...diskProfiledSnapshot.profile,
          disk: {
            ...diskProfiledSnapshot.profile.disk,
            protocolFailures: 1,
          },
        },
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...coreProfiledSnapshot,
        profile: {
          ...coreProfiledSnapshot.profile,
          worker: {
            ...coreProfiledSnapshot.profile.worker,
            core: {
              ...coreProfiledSnapshot.profile.worker.core,
              decodeMappingInvalidationChanges: 1n,
            },
          },
        },
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...coreProfiledSnapshot,
        profile: {
          ...coreProfiledSnapshot.profile,
          worker: {
            ...coreProfiledSnapshot.profile.worker,
            core: {
              ...coreProfiledSnapshot.profile.worker.core,
              jitChainAttempts: 1n,
            },
          },
        },
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...attributedSnapshot,
        profile: {
          ...attributedSnapshot.profile,
          worker: {
            ...attributedSnapshot.profile.worker,
            evictionReasons: {
              ...attributedSnapshot.profile.worker.evictionReasons,
              "byte-capacity": { bundles: 1, traces: 5, bytes: 50_000 },
            },
          },
        },
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...currentSnapshot,
        profile: {
          ...currentSnapshot.profile,
          worker: {
            ...currentSnapshot.profile.worker,
            interpreterReasons: {
              ...currentSnapshot.profile.worker.interpreterReasons,
              guard: {
                ...currentSnapshot.profile.worker.interpreterReasons.guard,
                batches: 2,
              },
            },
          },
        },
      }),
    ).toThrow(VMError);
    expect(
      controlResponseDecoders["read-system-trace"]({
        schemaVersion: 3,
        runtimeKey: snapshot.runtimeKey,
        capturedAt: snapshot.capturedAt,
        trigger: snapshot.trigger,
        capacity: snapshot.capacity,
        dropped: snapshot.dropped,
        runtime: snapshot.runtime,
        profile: snapshot.profile,
        state: snapshot.state,
        consoleTail: snapshot.consoleTail,
        events: snapshot.events,
      }),
    ).toMatchObject({
      schemaVersion: 3,
      executionMode: "unknown",
      interpretedSemantics: [],
      state: { registers },
    });
    const legacyState = {
      rip: traceState.rip,
      rflags: traceState.rflags,
      cr3: traceState.cr3,
      cpl: traceState.cpl,
      mode: traceState.mode,
    };
    const legacySnapshot = {
      schemaVersion: 2,
      runtimeKey: snapshot.runtimeKey,
      capturedAt: snapshot.capturedAt,
      trigger: snapshot.trigger,
      capacity: snapshot.capacity,
      dropped: snapshot.dropped,
      runtime: snapshot.runtime,
      profile: snapshot.profile,
      state: legacyState,
      consoleTail: snapshot.consoleTail,
      events: [
        snapshot.events[0],
        {
          ...snapshot.events[1],
          before: legacyState,
          after: { ...legacyState, rip: 0x1001n },
        },
        {
          ...snapshot.events[2],
          before: { ...legacyState, rip: 0x1001n },
          after: { ...legacyState, rip: 0x1002n },
        },
      ],
    } as const;
    expect(
      controlResponseDecoders["read-system-trace"](legacySnapshot),
    ).toMatchObject({
      schemaVersion: 2,
      executionMode: "unknown",
      interpretedSemantics: [],
      state: { registers: null },
      events: [
        {},
        { before: { registers: null }, after: { registers: null } },
        { before: { registers: null }, after: { registers: null } },
      ],
    });
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        events: [snapshot.events[1], snapshot.events[0]],
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        events: [
          {
            ...snapshot.events[1],
            contextAfter: {
              ...jitContext,
              pendingWrites: -1n,
            },
          },
        ],
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        trigger: "unexpected",
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        events: [{ ...snapshot.events[0], extra: true }],
      }),
    ).toThrow(VMError);
    expect(() =>
      controlResponseDecoders["read-system-trace"]({
        ...snapshot,
        state: legacyState,
      }),
    ).toThrow(VMError);
    expect(() =>
      decodeControlIncoming({
        id: 19,
        version: PROTOCOL_VERSION,
        type: "configure-system-trace",
        capacity: 32_769,
        interpreterOnly: false,
        interpretedSemantics: [],
        interpretedRipRanges: [],
        checkpointPolicy: "faults-and-stderr",
      }),
    ).toThrow(VMError);
  });

  it("strictly decodes guest agent and process messages", () => {
    const channel = new MessageChannel();
    expect(
      decodeControlIncoming({
        id: 20,
        version: PROTOCOL_VERSION,
        type: "agent-spawn",
        command: "bun",
        args: ["--bun", "run", "dev"],
        cwd: "/",
        env: { NEXT_TELEMETRY_DISABLED: "1" },
        terminal: { columns: 120, rows: 40 },
        port: channel.port1,
      }),
    ).toMatchObject({
      type: "agent-spawn",
      command: "bun",
      cwd: "/",
      terminal: { columns: 120, rows: 40 },
    });
    expect(() =>
      decodeControlIncoming({
        id: 21,
        version: PROTOCOL_VERSION,
        type: "agent-spawn",
        command: "/bin/sh",
        args: [],
        cwd: "/",
        env: {},
        terminal: { columns: 0, rows: 24 },
        port: channel.port2,
      }),
    ).toThrow(VMError);
    expect(() =>
      decodeControlIncoming({
        id: 21,
        version: PROTOCOL_VERSION,
        type: "agent-spawn",
        command: "bun",
        args: [],
        cwd: "/",
        env: { "INVALID-KEY": "1" },
        port: channel.port2,
      }),
    ).toThrow(VMError);
    expect(
      decodeGuestProcessWireEvent({
        version: PROTOCOL_VERSION,
        sessionId: 9,
        sequence: 1,
        type: "stdout",
        data: new Uint8Array([79, 75]),
      }),
    ).toMatchObject({ type: "stdout", sessionId: 9 });
    expect(
      decodeGuestProcessPortAck({
        version: PROTOCOL_VERSION,
        sessionId: 9,
        type: "output-ack",
        sequence: 1,
      }),
    ).toMatchObject({ type: "output-ack", sequence: 1 });
    expect(() =>
      decodeGuestProcessWireEvent({
        version: PROTOCOL_VERSION,
        sessionId: 9,
        sequence: 2,
        type: "exit",
        termination: { kind: "exit", code: 512 },
      }),
    ).toThrow(VMError);
    channel.port1.close();
    channel.port2.close();
  });


});
