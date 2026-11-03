/**
 * Exit statuses of a module's JS process. The adapter owns 0-119, the runner owns 120-124, and 125
 * belongs to the engine (it means the worker failed), so a module can never mimic an engine failure.
 */
export const MODULE_EXIT = {
  /**
   * The network is unavailable (sysexits EX_UNAVAILABLE): the VM is local-only, its connection was revoked, or the
   * destination is beyond the module's reach. A command prints one line from `kit.net.describe` and returns it (ADR 0029).
   */
  unavailable: 69,
  /** Highest status a command adapter may return from `main`. */
  adapterMax: 119,
  /** The launch descriptor was missing, oversized or invalid. */
  launch: 120,
  /** An artifact or the adapter did not match its pinned sha256. */
  integrity: 121,
  /** A declared browser feature or guest executable is missing. */
  prerequisite: 122,
  /** The adapter threw, had the wrong shape, `main` returned an invalid status, or a service could not serve. */
  adapter: 123,
  /** Another process already holds the module's exclusive workspace lock or one of its endpoints. */
  busy: 124,
  /** Reserved: the engine reports a failed worker with this status. */
  engine: 125,
} as const;

export type ModuleExitReason = "launch" | "integrity" | "prerequisite" | "adapter" | "busy";

/** `detail.reason` values `spawnModule` reports for the runner statuses. */
export const MODULE_EXIT_REASONS: Readonly<Record<ModuleExitReason, string>> = {
  launch: "wasm-module-launch",
  integrity: "wasm-module-integrity",
  prerequisite: "wasm-module-prerequisite",
  adapter: "wasm-module-adapter",
  busy: "wasm-module-busy",
};
