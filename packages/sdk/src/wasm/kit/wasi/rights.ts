/** WASI Preview1 rights (wasi_snapshot_preview1.witx `rights`). */
export const RIGHT = {
  fdDatasync: 1n << 0n, fdRead: 1n << 1n, fdSeek: 1n << 2n, fdFdstatSetFlags: 1n << 3n, fdSync: 1n << 4n, fdTell: 1n << 5n,
  fdWrite: 1n << 6n, fdAdvise: 1n << 7n, fdAllocate: 1n << 8n, pathCreateDirectory: 1n << 9n, pathCreateFile: 1n << 10n,
  pathLinkSource: 1n << 11n, pathLinkTarget: 1n << 12n, pathOpen: 1n << 13n, fdReaddir: 1n << 14n, pathReadlink: 1n << 15n,
  pathRenameSource: 1n << 16n, pathRenameTarget: 1n << 17n, pathFilestatGet: 1n << 18n, pathFilestatSetSize: 1n << 19n,
  pathFilestatSetTimes: 1n << 20n, fdFilestatGet: 1n << 21n, fdFilestatSetSize: 1n << 22n, fdFilestatSetTimes: 1n << 23n,
  pathSymlink: 1n << 24n, pathRemoveDirectory: 1n << 25n, pathUnlinkFile: 1n << 26n, pollFdReadwrite: 1n << 27n,
  sockShutdown: 1n << 28n,
} as const;
export const ALL_RIGHTS = (1n << 29n) - 1n;

/** Everything that changes a file or the tree; a read-only preopen and its descendants never hold these. */
export const MUTATING_RIGHTS = RIGHT.fdDatasync | RIGHT.fdWrite | RIGHT.fdAllocate | RIGHT.pathCreateDirectory | RIGHT.pathCreateFile
  | RIGHT.pathLinkTarget | RIGHT.pathRenameSource | RIGHT.pathRenameTarget | RIGHT.pathFilestatSetSize | RIGHT.pathFilestatSetTimes
  | RIGHT.fdFilestatSetSize | RIGHT.fdFilestatSetTimes | RIGHT.pathSymlink | RIGHT.pathRemoveDirectory | RIGHT.pathUnlinkFile
  | RIGHT.fdFdstatSetFlags | RIGHT.fdSync;

/** Rights that make an open descriptor writable (the access mode Linux needs), as wasmtime decides it. */
export const WRITE_RIGHTS = RIGHT.fdWrite | RIGHT.fdAllocate | RIGHT.fdFilestatSetSize;
export const READ_RIGHTS = RIGHT.fdRead | RIGHT.fdReaddir;

export function has(rights: bigint, needed: bigint): boolean { return (rights & needed) === needed; }
