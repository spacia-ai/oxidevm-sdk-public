import type {StorageRequest} from "../protocol/storage-requests.js";

/** Committed writes and newly owned read/selection handles must report their
 * outcome despite late cancellation, so the caller can retire their resources. */
export async function storageOutcome<T>(type:StorageRequest["type"],run:()=>Promise<T>,active:()=>void):Promise<T> {
 if(type!=="commit-workspace-streams")active();
 const value=await run();
 if(type!=="commit-workspace-streams"&&type!=="commit-workspace-snapshot"&&type!=="commit-workspace-delta"
  &&type!=="write-file"&&type!=="snapshot-import"&&type!=="select-userspace-files"&&type!=="initial-start-retire")active();
 return value;
}
