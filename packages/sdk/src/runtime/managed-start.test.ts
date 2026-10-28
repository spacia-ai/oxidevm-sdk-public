import { describe, expect, it } from "vitest";

import { VMError } from "./errors.js";
import { type ManagedStartPort, type ResumedSession, startManaged } from "./managed-start.js";
import type { SnapshotInfo, SnapshotResumability } from "./protocol.js";
import {decodeShippedInstallIdentity} from "./protocol/shipped-source.js";

function info(sequence: number, resumable: SnapshotResumability = true): SnapshotInfo {
  return {
    mode: "system",
    ref: { id: `123e4567-e89b-42d3-a456-42661417400${String(sequence)}`, createdAt: "2026-10-02T10:00:00.000Z" },
    kind: "automatic",
    capturedAtUnixMs: 1_790_000_000_000 + sequence,
    profile: { id: "alpine", version: "2026.10.02" },
    bytes: { ram: 0, disk: 0, unique: 0 },
    resumable,
  };
}

const SESSION: ResumedSession = {
  appData: null,
  terminals: [],
  newerFilesDropped: false,
  workspace: "in-sync",
};

const damaged = () => new VMError("STORAGE_ERROR", "a snapshot object failed integrity validation", { reason: "snapshot-damaged" });

const SHIPPED: SnapshotInfo = { ...info(9), kind: "shipped", label: "Boundary · container ready" };
const SOURCE=decodeShippedInstallIdentity({mode:"system",snapshotManifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32)});
for(const restart of ["none","pre-resume","fresh-image","update-image"] as const)it(`retires pending initialization after successful ${restart} before returning a VM`,async()=>{
  const f=port([],new Map(),false),calls:string[]=[];
  const explicit={...f.fake,coldBoot:()=>{calls.push("cold");return Promise.resolve();},retireInitialStart:()=>{calls.push("retire");return Promise.resolve();}};
  await startManaged(explicit,restart);expect(calls).toEqual(["cold","retire"]);
});
it("a failed deliberate boot keeps its pending source retryable",async()=>{
  const f=port([],new Map(),false);let retired=false;
  await expect(startManaged({...f.fake,coldBoot:()=>Promise.reject(new VMError("VM_FAULT","boot failed")),retireInitialStart:()=>{retired=true;return Promise.resolve();}},"none")).rejects.toThrow("boot failed");
  expect(retired).toBe(false);
});
it("failed retirement after an explicit restore cannot choose another session",async()=>{
  const selected=info(1),f=port([selected]);
  await expect(startManaged({...f.fake,retireInitialStart:()=>Promise.reject(new VMError("STORAGE_ERROR","retirement failed"))},selected.ref)).rejects.toThrow("retirement failed");
  expect(f.calls.some(call=>call.startsWith("cold"))).toBe(false);
});

it("new_ref_failure_never_cold_boots",async()=>{
  const f=port([],new Map(),false);
  const required={...f.fake,initialStart:()=>Promise.resolve({kind:"empty"} as const),
    shipped:{kind:"reference" as const,source:SOURCE,install:()=>Promise.reject(new VMError("PERMISSION_DENIED","bad signature"))}};
  await expect(startManaged(required,"latest")).rejects.toMatchObject({code:"PERMISSION_DENIED"});
  expect(f.calls.some(call=>call.startsWith("cold"))).toBe(false);
});
it("returning_files_never_install_shipped",async()=>{
  const f=port([],new Map(),false);
  let installed=false;
  const required={...f.fake,initialStart:()=>Promise.resolve({kind:"existing"} as const),
    shipped:{kind:"reference" as const,source:SOURCE,install:()=>{installed=true;return Promise.resolve(SHIPPED);}}};
  const result=await startManaged(required,"latest");
  expect(result.kind).toBe("booted");expect(installed).toBe(false);
});
it("pending_initial_import_is_not_user_latest_candidate",async()=>{
  const own=info(1),f=port([own],new Map(),true);
  const required={...f.fake,initialStart:()=>Promise.resolve({kind:"pending",source:SOURCE} as const),
    shipped:{kind:"reference" as const,source:SOURCE,install:()=>Promise.resolve(SHIPPED)}};
  expect((await startManaged(required,"latest")).kind).toBe("resumed");
  expect(f.calls).toEqual(["resume 9"]);
});

it("propagates cancellation without cold-booting or installing a fallback", async () => {
  const latest = info(2), aborted = () => new VMError("ABORTED", "cancelled");
  for (const f of [port([latest], new Map([[latest, aborted]])), port([], new Map(), false, () => Promise.reject(aborted()))]) {
    await expect(startManaged(f.fake, "latest")).rejects.toMatchObject({ code: "ABORTED" });
    expect(f.calls.some(call => call.startsWith("cold"))).toBe(false);
  }
});

/**
 * A port whose resume of each restore point succeeds unless `failures` names it; with
 * `shipped`, the page asked for a shipped restore point, which `shipped` installs.
 */
function port(
  candidates: readonly SnapshotInfo[],
  failures: ReadonlyMap<SnapshotInfo, () => Error> = new Map(),
  restorePoints = true,
  shipped?: () => Promise<SnapshotInfo>,
) {
  const calls: string[] = [];
  const fake: ManagedStartPort = {
    initialStart:()=>Promise.resolve({kind:restorePoints?"existing":"empty"}),
    retireInitialStart:()=>Promise.resolve(),
    ...(shipped === undefined ? {} : {
      shipped: {kind:"listed",install: () => {
        calls.push("install shipped");
        return shipped();
      }},
    }),
    candidates: (resume) => {
      calls.push(resume === "latest" ? "candidates latest" : `candidates ${resume.id}`);
      return Promise.resolve(candidates);
    },
    hasRestorePoints: () => Promise.resolve(restorePoints),
    resume: (snapshot) => {
      calls.push(`resume ${snapshot.ref.id.slice(-1)}`);
      const failure = failures.get(snapshot);
      return failure === undefined ? Promise.resolve(SESSION) : Promise.reject(failure());
    },
    coldBoot: (boot) => {
      calls.push(`cold ${boot}`);
      return Promise.resolve();
    },
  };
  return { fake, calls };
}

describe("managed start", () => {
  it("resumes the restore point the VM last matched", async () => {
    const latest = info(2);
    const { fake, calls } = port([latest, info(1)]);

    await expect(startManaged(fake, "latest")).resolves.toEqual({ kind: "resumed", snapshot: latest, ...SESSION });
    expect(calls).toEqual(["candidates latest", "resume 2"]);
  });

  it("falls back to the earlier save when the latest is damaged, naming the one it skipped", async () => {
    const unreadable = info(3, "corrupt");
    const failing = info(2);
    const earlier = info(1);
    const { fake, calls } = port([unreadable, failing, earlier], new Map([[failing, damaged]]));

    await expect(startManaged(fake, "latest")).resolves.toEqual({
      kind: "resumed",
      snapshot: earlier,
      ...SESSION,
      skipped: unreadable,
    });
    expect(calls).toEqual(["candidates latest", "resume 2", "resume 1"]);
  });

  it("names the newest restore point it skipped when several are damaged", async () => {
    const newest = info(3, "corrupt");
    const next = info(2, "corrupt");
    const earlier = info(1);
    const { fake } = port([newest, next, earlier]);

    await expect(startManaged(fake, "latest")).resolves.toMatchObject({ kind: "resumed", snapshot: earlier, skipped: newest });
  });

  it("boots the live disk cold when the latest restore point cannot resume this VM", async () => {
    const older = info(2, "older-format");
    const { fake, calls } = port([older, info(1)]);

    await expect(startManaged(fake, "latest")).resolves.toEqual({ kind: "booted", reason: "incompatible", skipped: older });
    expect(calls).toEqual(["candidates latest", "cold live"]);
  });

  it("boots cold when there is nothing to resume, telling a first start from a cold-booted VM", async () => {
    const first = port([], new Map(), false);
    await expect(startManaged(first.fake, "latest")).resolves.toEqual({ kind: "booted", reason: "first-start" });
    expect(first.calls).toEqual(["candidates latest", "cold live"]);

    const later = port([]);
    await expect(startManaged(later.fake, "latest")).resolves.toEqual({ kind: "booted", reason: "no-save" });
  });

  it("restarts from the live disk, the disk from before a resume, or a fresh image when asked", async () => {
    const restart = port([info(1)]);
    await expect(startManaged(restart.fake, "none")).resolves.toEqual({ kind: "booted", reason: "restart" });
    expect(restart.calls).toEqual(["cold live"]);

    const instead = port([info(1)]);
    await expect(startManaged(instead.fake, "pre-resume")).resolves.toEqual({ kind: "booted", reason: "restart" });
    expect(instead.calls).toEqual(["cold pre-resume"]);

    const reset = port([info(1)]);
    await expect(startManaged(reset.fake, "fresh-image")).resolves.toEqual({ kind: "booted", reason: "fresh-image" });
    expect(reset.calls).toEqual(["cold fresh-image"]);

    const update = port([info(1)]);
    await expect(startManaged(update.fake, "update-image")).resolves.toEqual({ kind: "booted", reason: "update-image" });
    expect(update.calls).toEqual(["cold update-image"]);
  });

  it("resumes a chosen restore point without trying others", async () => {
    const chosen = info(1);
    const { fake, calls } = port([chosen]);

    await expect(startManaged(fake, chosen.ref)).resolves.toMatchObject({ kind: "resumed", snapshot: chosen });
    expect(calls).toEqual([`candidates ${chosen.ref.id}`, "resume 1"]);
  });

  it("opens the shipped restore point when the learner has no save of their own", async () => {
    const { fake, calls } = port([], new Map(), false, () => Promise.resolve(SHIPPED));

    await expect(startManaged(fake, "latest")).resolves.toEqual({ kind: "resumed", snapshot: SHIPPED, ...SESSION });
    expect(calls).toEqual(["candidates latest", "install shipped", "resume 9"]);
  });

  it("resumes the learner's own save before any shipped restore point", async () => {
    const own = info(2);
    const { fake, calls } = port([own], new Map(), true, () => Promise.resolve(SHIPPED));

    await expect(startManaged(fake, "latest")).resolves.toMatchObject({ kind: "resumed", snapshot: own });
    expect(calls).toEqual(["candidates latest", "resume 2"]);
  });

  it("boots the learner's own newest files, not the shipped restore point, once they have saves", async () => {
    const own = info(2);
    const damagedOwn = port([own], new Map([[own, damaged]]), true, () => Promise.resolve(SHIPPED));
    await expect(startManaged(damagedOwn.fake, "latest")).resolves.toEqual({ kind: "booted", reason: "damaged", skipped: own });
    expect(damagedOwn.calls).toEqual(["candidates latest", "resume 2", "cold live"]);

    const older = { ...info(3), resumable: "older-format" as const };
    const incompatible = port([older], new Map(), true, () => Promise.resolve(SHIPPED));
    await expect(startManaged(incompatible.fake, "latest")).resolves.toEqual({ kind: "booted", reason: "incompatible", skipped: older });
    expect(incompatible.calls).toEqual(["candidates latest", "cold live"]);

    // Saves exist, but the learner restarted since: their newest files boot.
    const restarted = port([], new Map(), true, () => Promise.resolve(SHIPPED));
    await expect(startManaged(restarted.fake, "latest")).resolves.toEqual({ kind: "booted", reason: "no-save" });
    expect(restarted.calls).toEqual(["candidates latest", "cold live"]);
  });

  it("boots cold and says why the shipped restore point could not open", async () => {
    const shippedFailure = (reason: string) => () => Promise.reject(new VMError("STORAGE_ERROR", "shipped", { reason: `shipped-${reason}` }));
    for (const reason of ["untrusted", "signature-invalid", "newer", "older", "incompatible", "damaged", "unavailable"]) {
      const { fake, calls } = port([], new Map(), false, shippedFailure(reason));
      await expect(startManaged(fake, "latest"), reason).resolves.toEqual({ kind: "booted", reason: "first-start", shipped: { reason } });
      expect(calls).toEqual(["candidates latest", "install shipped", "cold live"]);
    }
    const full = port([], new Map(), false, () => Promise.reject(new VMError("QUOTA_EXCEEDED", "full")));
    await expect(startManaged(full.fake, "latest")).resolves.toEqual({ kind: "booted", reason: "first-start", shipped: { reason: "no-space" } });

    for (const [failure, reason] of [
      [() => new VMError("GUEST_CRASH", "silent", { reason: "agent-unavailable" }), "agent-unavailable"],
      [() => new VMError("PROTOCOL_ERROR", "stream ended"), "restore-failed"],
    ] as const) {
      const opened = port([], new Map([[SHIPPED, failure]]), false, () => Promise.resolve(SHIPPED));
      await expect(startManaged(opened.fake, "latest"), reason).resolves.toEqual({ kind: "booted", reason: "first-start", shipped: { reason } });
      expect(opened.calls).toEqual(["candidates latest", "install shipped", "resume 9", "cold live"]);
    }
  });

  it("never opens a shipped restore point to restart, reset or resume a chosen point", async () => {
    const chosen = info(1);
    for (const [resume, expected] of [["none", "cold live"], ["fresh-image", "cold fresh-image"]] as const) {
      const { fake, calls } = port([], new Map(), false, () => Promise.resolve(SHIPPED));
      await startManaged(fake, resume);
      expect(calls).toEqual([expected]);
    }
    const { fake, calls } = port([chosen], new Map([[chosen, damaged]]), true, () => Promise.resolve(SHIPPED));
    await expect(startManaged(fake, chosen.ref)).resolves.toMatchObject({ kind: "booted", reason: "damaged" });
    expect(calls).not.toContain("install shipped");
  });

  it("says why a resume failed and boots the live disk instead", async () => {
    const latest = info(2);
    const cases: readonly (readonly [() => Error, string])[] = [
      [() => new VMError("QUOTA_EXCEEDED", "the browser has no room"), "no-space"],
      [() => new VMError("GUEST_CRASH", "the restored agent did not answer", { reason: "agent-unavailable" }), "agent-unavailable"],
      [() => new VMError("PROTOCOL_ERROR", "the restore stream ended early"), "restore-failed"],
      [damaged, "damaged"],
    ];
    for (const [failure, reason] of cases) {
      const { fake, calls } = port([latest], new Map([[latest, failure]]));

      await expect(startManaged(fake, "latest")).resolves.toEqual({ kind: "booted", reason, skipped: latest });
      expect(calls).toEqual(["candidates latest", "resume 2", "cold live"]);
    }
  });
});
