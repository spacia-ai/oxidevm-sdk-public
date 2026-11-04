/**
 * The first-release profile limits (SL-01 contract). Each is enforced where it is named and has a
 * boundary test at the endpoint and one past it.
 */
export const LIMITS = Object.freeze({
  /** Bytes of argv or of the environment, each, including the NUL terminators the ABI adds. */
  launchBytes: 64 * 1024,
  /** Entries in one fd_read/fd_write iovec list. */
  iovecs: 128,
  /** Bytes one fd_read/fd_write call may move in total. */
  ioBytes: 1024 * 1024,
  /** Bytes one host read or write moves; larger requests are chunked and may return a partial count. */
  ioChunk: 64 * 1024,
  /** Declared maximum of the one defined memory, in 64 KiB pages (256 MiB). */
  memoryPages: 4096,
  /** Entries of the one funcref table. */
  tableEntries: 65536,
  /** Bytes of a guest path, without the terminator Linux adds. */
  pathBytes: 4095,
  /** Guest descriptors per run, standard streams and preopens included. */
  descriptors: 256,
  /** Bytes of a local program file (rust-wasi runner). */
  programBytes: 32 * 1024 * 1024,
} as const);

/** The module-main status range the SDK carries exactly (`@oxidevm/sdk/wasm` exit codes). */
export const MAX_EXACT_EXIT = 119;
