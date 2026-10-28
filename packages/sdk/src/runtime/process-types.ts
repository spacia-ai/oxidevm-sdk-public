export interface ProcessHandle {
  /** Stable key matching a restored process, when its transport has snapshot authority. */
  readonly snapshotKey?:string;
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exit: Promise<{ code: number | null; signal?: string }>;
  kill(signal?: string): Promise<void>;
  /** Resize an attached Userspace PTY; unavailable backends fail explicitly. */
  resizeTerminal?(size: { readonly columns: number; readonly rows: number }): Promise<void>;
}
