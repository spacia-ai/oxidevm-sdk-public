import type { DiskBridgeClient } from "../../disk-bridge.js";
import { VMError } from "../../errors.js";
import { type Core, assertStatus, callNumber } from "./core.js";

const QUIESCE_TIMEOUT_MILLISECONDS = 30_000;

export async function quiesceHostDisk(
  loaded: Core | undefined,
  bridge: DiskBridgeClient | undefined,
  systemBooted: boolean,
): Promise<void> {
  if (!systemBooted || loaded === undefined || bridge === undefined) return;
  const deadline = performance.now() + QUIESCE_TIMEOUT_MILLISECONDS;
  for (;;) {
    assertStatus(callNumber(loaded, "oxidevm_system_service_devices"));
    const pending = callNumber(
      loaded,
      "oxidevm_system_pending_block_requests",
    );
    if (pending === 0 && bridge.commandDepth() === 0) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0 || pending === 0xffff_ffff) {
      throw new VMError("STORAGE_ERROR", "managed disk quiesce timed out");
    }
    if (bridge.commandDepth() === 0 && bridge.pendingCount() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else {
      await waitForProgress(bridge, remaining);
    }
  }
}

export function attachHostDisk(
  loaded: Core,
  bridge: DiskBridgeClient | undefined,
  bytes: number | undefined,
): void {
  if (bytes === undefined) return;
  if (bridge === undefined) {
    throw new VMError(
      "FEATURE_NOT_AVAILABLE",
      "managed disks require cross-origin isolation and SharedArrayBuffer",
    );
  }
  assertStatus(
    callNumber(loaded, "oxidevm_system_use_host_disk", [
      bytes >>> 0,
      Math.floor(bytes / 0x1_0000_0000),
    ]),
  );
}

async function waitForProgress(
  bridge: DiskBridgeClient,
  timeoutMilliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new VMError("STORAGE_ERROR", "managed disk quiesce timed out"),
        ),
      timeoutMilliseconds,
    );
    void bridge.waitForProgress().then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
