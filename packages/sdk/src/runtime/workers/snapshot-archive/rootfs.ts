import { integer, record } from "../../decode.js";
import { decodeUserspaceRootfsManifest, USERSPACE_ROOTFS_SCHEMA } from "../../userspace-rootfs.js";
import type { UserspaceSnapshotManifest } from "../snapshot-manifest.js";
import { backupError, isBackupError } from "./errors.js";

/** Embedded image support is checked before an imported checkpoint can become visible. */
export function validateBackupRootfs(bytes:Uint8Array,snapshot:UserspaceSnapshotManifest):void {
  try {
    const source=record(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown,"backup rootfs");
    const version=integer(source["schemaVersion"],"rootfs schema version");
    if(version>USERSPACE_ROOTFS_SCHEMA)throw backupError("newer","this backup requires a newer Userspace image format");
    if(version<1)throw backupError("older","this backup requires an older Userspace image format");
    const manifest=decodeUserspaceRootfsManifest(source,new URL("https://oxidevm-backup.invalid/manifest.json"));
    if(manifest.id!==snapshot.rootfs.image.id||manifest.version!==snapshot.rootfs.image.version||manifest.rootTreeSha256!==snapshot.rootfs.rootTreeSha256) {
      throw backupError("damaged","the backup's rootfs does not match its image pin");
    }
  }catch(error){if(isBackupError(error))throw error;throw backupError("damaged","the backup's rootfs manifest is invalid");}
}
