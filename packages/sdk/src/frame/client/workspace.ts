import type { Workspace, WorkspaceEntry, WorkspacePersistence, WorkspaceWatch } from "../../contracts.js";
import { exactKeys, record, string } from "../../runtime/decode.js";
import { VMError } from "../../runtime/errors.js";
import { decodeFileEntry, decodeWorkspaceChanges } from "../../runtime/protocol/workspace-files.js";
import { MAX_WORKSPACE_FILE_BYTES, validateWorkspaceReadLimit, validateWorkspaceVersion } from "../../runtime/workspace-files.js";
import type { FrameOperation } from "../protocol/requests.js";
import { decodeUnit } from "../protocol/values.js";
import { decodeFrameEntries, decodeFrameFile, watchedDirectories } from "../protocol/workspace.js";
import type { FrameCall } from "./channel.js";

// The page's workspace in frame mode: each method is a request to the runtime frame's workspace,
// whose own validation runs there. Limits a wire decoder bounds are checked here first with the
// workspace owner's validators, so a bad argument fails as it would in a self-hosted VM.

type Call = <T>(operation: FrameOperation, request: FrameCall<T>) => Promise<T>;

export function frameWorkspace(call: Call, description: { readonly id: string; readonly persistence: WorkspacePersistence }): Workspace {
  const unit = (operation: FrameOperation, signal?: AbortSignal) => call(operation, { decode: decodeUnit, signal });
  return {
    id: description.id, persistence: description.persistence,
    readFile: (path, signal) => call({ type: "workspace.read", path }, { decode: decodeBytes, signal }),
    readText: (path, signal) => call({ type: "workspace.readText", path }, { decode: value => string(value, "workspace text"), signal }),
    writeFile: (path, data, signal) => unit({ type: "workspace.write", path, data }, signal),
    writeText: (path, data, signal) => unit({ type: "workspace.writeText", path, data }, signal),
    list: (path = "/", signal) => call({ type: "workspace.list", path }, { decode: decodeEntries, signal }),
    remove: (path, removal) => unit({ type: "workspace.remove", path, recursive: removal?.recursive === true }, removal?.signal),
    entries: (path = "/", signal) => call({ type: "workspace.entries", path }, { decode: decodeFrameEntries, signal }),
    stat: (path, signal) => call({ type: "workspace.stat", path }, { decode: decodeFileEntry, signal }),
    read: async (path, options = {}) => {
      const maxBytes = validateWorkspaceReadLimit(options.maxBytes ?? MAX_WORKSPACE_FILE_BYTES);
      return call({ type: "workspace.readEntry", path, ...(options.maxBytes === undefined ? {} : { maxBytes }) }, { decode: value => decodeFrameFile(value, maxBytes), signal: options.signal });
    },
    write: async (path, data, options = {}) => {
      validateWorkspaceVersion(options.ifVersion);
      return call({ type: "workspace.writeEntry", path, data, ...(options.ifVersion === undefined ? {} : { ifVersion: options.ifVersion }) }, { decode: decodeFileEntry, signal: options.signal });
    },
    createDirectory: (path, options) => unit({ type: "workspace.createDirectory", path }, options?.signal),
    rename: (from, to, options) => unit({ type: "workspace.rename", from, to }, options?.signal),
    watch: (onChange, options): WorkspaceWatch => {
      let watch: number | undefined;
      const done = call({ type: "workspace.watch" }, {
        decode: decodeUnit, signal: options.signal, onAbort: "resolve", onSent: id => { watch = id; },
        // Changes reach the listener as they do in a self-hosted VM: decoded, in a later microtask.
        onEvent: event => { const changes = decodeWorkspaceChanges(event); queueMicrotask(() => { onChange(changes); }); },
      });
      return {
        done,
        setDirectories: async paths => {
          const directories = watchedDirectories(paths);
          if (watch === undefined) throw new VMError("ABORTED", "workspace watch has ended");
          return unit({ type: "workspace.watch.setDirectories", watch, directories });
        },
      };
    },
  };
}

function decodeEntries(value: unknown): readonly WorkspaceEntry[] {
  if (!Array.isArray(value)) throw new VMError("PROTOCOL_ERROR", "workspace entries must be a list");
  const entries: readonly unknown[] = value;
  return entries.map(entry => {
    const item = record(entry, "workspace entry");
    exactKeys(item, ["kind", "name", "path"]);
    const kind = item["kind"];
    if (kind !== "file" && kind !== "directory" && kind !== "symlink") throw new VMError("PROTOCOL_ERROR", "workspace entry kind is invalid");
    return { kind, name: string(item["name"], "entry name"), path: string(item["path"], "entry path") };
  });
}

function decodeBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new VMError("PROTOCOL_ERROR", "file contents must be bytes");
  return value;
}
