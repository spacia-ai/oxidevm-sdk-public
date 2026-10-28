/** The capability used by backup export. Native picked file handles satisfy it. */
export interface BackupDestination {
  readonly kind: "file";
  createWritable(options?: { readonly keepExistingData?: boolean }): Promise<{
    write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
  }>;
}
