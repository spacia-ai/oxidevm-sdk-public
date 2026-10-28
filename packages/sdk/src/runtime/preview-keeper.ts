// The seam between a preview session (preview-session.ts) and the document that embeds its keeper:
// this page in a self-hosted runtime, or the page that embeds the runtime frame (ADR 0021). Types
// only, with no DOM, so runtime option types can name the seam in every module graph.

/** The hidden keeper document. Tests supply a host that never touches the
 * real document; production embeds a sandboxed iframe. */
export interface PreviewKeeper {
  readonly source: object | null;
  /** Best-effort notice that the session retired, so the keeper can tell its worker. */
  retire(session: string): void;
  close(): void;
}
/** A message that reached the embedding document, reduced to what the
 * session needs: the sender's origin, its payload, and a way to answer it. */
export interface KeeperMessage {
  readonly origin: string;
  readonly data: unknown;
  readonly source: KeeperSource | null;
}
export interface KeeperSource {
  readonly identity: object;
  postMessage(message: unknown, options: { readonly targetOrigin: string; readonly transfer: Transferable[] }): void;
}
export interface PreviewKeeperHost {
  /** The origin the keeper answers to: the document that embeds it. */
  readonly origin: string;
  open(url: URL): PreviewKeeper;
  /** Delivers every message the embedding document receives until the returned function runs. */
  listen(listener: (message: KeeperMessage) => void): () => void;
}
