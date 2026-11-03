import { expect, it } from "vitest";
import { VMError } from "../errors.js";
import { decodeUserspaceStorageFailureProfile, MAX_RECENT_STORAGE_FAILURES } from "../protocol/userspace-storage-failures.js";
import { UserspaceStorageFailures } from "./userspace-storage-failures.js";

it("keeps the typed cause of every image read the guest sees as EIO, bounded to the latest", () => {
  const failures = new UserspaceStorageFailures(), chunk = "c".repeat(64);
  expect(failures.record(new VMError("STORAGE_NOT_FOUND", "absent"), "/missing")).toBe("not-found");
  expect(failures.record(new VMError("ABORTED", "cancelled"), "/cancelled")).toBe("aborted");
  expect(failures.profile()).toEqual({ total: 0, recent: [] });
  expect(failures.record(new VMError("QUOTA_EXCEEDED", "quota", { reason: "image-pack-space-refused", chunk, stage: "write" }), "/usr/lib/python3.12/traceback.py")).toBe("io");
  expect(failures.record(new VMError("STORAGE_ERROR", "other", { reason: "free-form", chunk: "not-a-digest" }), "/other")).toBe("io");
  expect(failures.record(new VMError("PROTOCOL_ERROR", "length"), "/short")).toBe("io");
  expect(failures.record(new TypeError("unexpected"), "/thrown")).toBe("io");
  expect(failures.profile().recent).toEqual([
    { code: "QUOTA_EXCEEDED", reason: "image-pack-space-refused", path: "/usr/lib/python3.12/traceback.py", chunk },
    { code: "STORAGE_ERROR", reason: "unclassified", path: "/other" },
    { code: "PROTOCOL_ERROR", reason: "response-invalid", path: "/short" },
    { code: "STORAGE_ERROR", reason: "unclassified", path: "/thrown" },
  ]);
  for (let index = 0; index < MAX_RECENT_STORAGE_FAILURES; index++) failures.record(new VMError("STORAGE_ERROR", "damaged", { reason: "image-not-cached" }), `/file-${String(index)}`);
  const profile = failures.profile();
  expect(profile.total).toBe(4 + MAX_RECENT_STORAGE_FAILURES);
  expect(profile.recent).toHaveLength(MAX_RECENT_STORAGE_FAILURES);
  expect(profile.recent[0]).toEqual({ code: "STORAGE_ERROR", reason: "image-not-cached", path: "/file-0" });
  expect(decodeUserspaceStorageFailureProfile(profile)).toEqual(profile);
});
