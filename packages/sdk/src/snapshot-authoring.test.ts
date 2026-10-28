import {expect, it} from "vitest";
import type {SystemOptions, UserspaceOptions} from "./contracts.js";
import type {SnapshotProcess, SnapshotPreparationContext} from "./snapshot-authoring.js";
import {defineShippedSnapshot} from "./shipped-snapshot.js";

function checkContracts(ctx: SnapshotPreparationContext, pipe: Extract<SnapshotProcess, {kind: "process"}>, native: UserspaceOptions) {
  void ctx.start("shell", {command: "/bin/sh", terminal: {columns: 80, rows: 24}}).then(shell => shell.resize({columns: 90, rows: 25}));
  // @ts-expect-error Pipe wrappers have no terminal resize operation.
  const terminalOnly: Pick<Extract<SnapshotProcess, {kind:"terminal"}>, "resize"> = pipe;
  // @ts-expect-error Userspace resources never accept vCPUs.
  const foreign: UserspaceOptions = {...native, vcpus: 2};
  // @ts-expect-error A Userspace shipped reference cannot be installed in System mode.
  const system: SystemOptions = {mode: "system", shipped: defineShippedSnapshot({mode: "userspace", name: "ready", manifestUrl: "/manifest.json", manifestSHA256: "ab".repeat(32), imageManifestSHA256: "cd".repeat(32), manifestBytes: 1, downloadBytes: 1, trust: {algorithm: "Ed25519", keyId: "test", publicKey: ""}})};
  return {foreign, system, terminalOnly};
}
it("keeps authoring process capabilities and VM modes distinct", () => {
  expect(typeof checkContracts).toBe("function");
});
