/** The 46 functions of WASI Preview1 (wasi_snapshot_preview1.witx); test/wasi-preview1-imports.json gives each a disposition. */
export const PREVIEW1_NAMESPACE = "wasi_snapshot_preview1";
export const PREVIEW1_IMPORTS = [
  "args_get", "args_sizes_get", "environ_get", "environ_sizes_get",
  "clock_res_get", "clock_time_get",
  "fd_advise", "fd_allocate", "fd_close", "fd_datasync", "fd_fdstat_get", "fd_fdstat_set_flags", "fd_fdstat_set_rights",
  "fd_filestat_get", "fd_filestat_set_size", "fd_filestat_set_times", "fd_pread", "fd_prestat_get", "fd_prestat_dir_name",
  "fd_pwrite", "fd_read", "fd_readdir", "fd_renumber", "fd_seek", "fd_sync", "fd_tell", "fd_write",
  "path_create_directory", "path_filestat_get", "path_filestat_set_times", "path_link", "path_open", "path_readlink",
  "path_remove_directory", "path_rename", "path_symlink", "path_unlink_file",
  "poll_oneoff", "proc_exit", "proc_raise", "sched_yield", "random_get",
  "sock_accept", "sock_recv", "sock_send", "sock_shutdown",
] as const;
export type Preview1Name = (typeof PREVIEW1_IMPORTS)[number];

const KNOWN: ReadonlySet<string> = new Set(PREVIEW1_IMPORTS);
export function isPreview1Name(name: string): name is Preview1Name { return KNOWN.has(name); }

/** The OxideVM bridge namespace of this release; a different major is refused before the program starts. */
export const BRIDGE_NAMESPACE = "oxidevm_bridge_v1";
