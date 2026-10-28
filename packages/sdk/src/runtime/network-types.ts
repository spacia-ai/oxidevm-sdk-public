import type { RelayFailureReason } from "./workers/relay-generated.js";
export type { RelayFailureReason } from "./workers/relay-generated.js";
/** Relay access is scoped to this VM's origin, workspace, and browser session. */
export type RelayConnectionOptions =
  | { readonly kind: "personal"; readonly workspaceName?: string; readonly url?: never; readonly sessionUrl?: never; readonly headers?: never }
  | { readonly kind: "server"; readonly url: string | URL; readonly sessionUrl?: string | URL; readonly headers?: Readonly<Record<string, string>> };

export type NetworkState =
  | { readonly kind: "off" }
  | { readonly kind: "discovering" }
  | { readonly kind: "awaiting-approval"; readonly code: string; readonly origin: string; readonly workspaceId: string; readonly workspaceName: string; readonly expiresAt: number }
  | { readonly kind: "connecting"; readonly relay: "personal" | "server" }
  | { readonly kind: "connected"; readonly relay: "personal" | "server"; readonly expiresAt: number }
  | { readonly kind: "failed"; readonly reason: RelayFailureReason };

export interface VMNetwork {
  readonly state: NetworkState;
  /** Resolves after authorization and both transport and runtime adapter readiness. */
  connect(options: RelayConnectionOptions, request?: { readonly signal?: AbortSignal }): Promise<void>;
  /** Revokes access and cleans up pending external I/O. Safe to call repeatedly. */
  disconnect(): Promise<void>;
  /** Immediately reports the current state. Stops when the signal is aborted. */
  watch(onChange: (state: NetworkState) => void, options: { readonly signal: AbortSignal }): Promise<void>;
}
