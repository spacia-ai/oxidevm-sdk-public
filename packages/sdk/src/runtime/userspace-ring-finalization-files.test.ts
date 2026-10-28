import { describe, expect, it } from "vitest";
import { decodeRingFinalizationProgress } from "./userspace-ring-finalization-progress.ts";

const descriptor = {
  kind: 4, phase: 10, resource: 1, origin: 57n, index: 65_536,
  pinsBefore: 257n, metadataReferencesBefore: 8192n, tag: 0n,
  ringsPages: 0, sqePages: 0, metadataPages: 0, lockedPagesBefore: 0n,
} satisfies Parameters<typeof decodeRingFinalizationProgress>[0];
const metadata = { ...descriptor, phase: 11, resource: 0, origin: 0n, index: 0, pinsBefore: 0n, metadataReferencesBefore: 3n };
const owner = { ...metadata, phase: 12, metadataReferencesBefore: 0n };

describe("fixed-file final ring progress", () => {
  it("retains a 32-bit slot and its original description and metadata counts", () => {
    expect(decodeRingFinalizationProgress(descriptor)).toEqual({
      kind: "files", phase: "file-descriptor", slot: 65_536, openFileId: 57n,
      descriptorsBefore: 257, metadataPagesBefore: 8192,
    });
  });

  it("distinguishes one metadata page from the empty admitted table owner", () => {
    expect(decodeRingFinalizationProgress(metadata)).toEqual({ kind: "files", phase: "file-metadata", metadataPagesBefore: 3 });
    expect(decodeRingFinalizationProgress(owner)).toEqual({ kind: "files", phase: "file-owner" });
  });

  it.each([
    { ...descriptor, resource: 0 }, { ...descriptor, resource: 2 },
    { ...descriptor, origin: 0n }, { ...descriptor, origin: 0xffff_ffff_ffff_ffffn },
    { ...descriptor, index: -1 }, { ...descriptor, index: 0.5 }, { ...descriptor, index: 1_048_576 },
    { ...descriptor, pinsBefore: 0n }, { ...descriptor, pinsBefore: 1_048_577n },
    { ...descriptor, metadataReferencesBefore: 0n }, { ...descriptor, metadataReferencesBefore: 8193n },
    { ...descriptor, metadataReferencesBefore: 1n },
    { ...descriptor, tag: 1n }, { ...descriptor, ringsPages: 1 }, { ...descriptor, sqePages: 1 },
    { ...descriptor, metadataPages: 1 }, { ...descriptor, lockedPagesBefore: 1n },
    { ...metadata, resource: 1 }, { ...metadata, origin: 1n }, { ...metadata, index: 1 },
    { ...metadata, pinsBefore: 1n }, { ...metadata, metadataReferencesBefore: 0n },
    { ...owner, metadataReferencesBefore: 1n }, { ...owner, phase: 0 },
  ])("rejects malformed or mixed resource fields %#", raw => {
    expect(() => decodeRingFinalizationProgress(raw)).toThrow("ring finalization progress is malformed");
  });
});
