import type { Workspace, WorkspaceWatch } from "../../contracts.js";
import { VMError } from "../../runtime/errors.js";
import type { FrameRequest } from "../protocol/requests.js";
import { encodeFileEntry, encodeWorkspaceChanges } from "../protocol/workspace.js";

// What each workspace request does to the frame VM's workspace. A watch lasts until the page
// cancels it (or the VM ends it); while it runs, `watches` holds it under its request id so the
// page's `workspace.watch.setDirectories` requests reach it.

export type WorkspaceRequest = Extract<FrameRequest, { readonly type: `workspace.${string}` }>;

export interface WorkspaceDispatch {
  readonly workspace: Workspace;
  readonly signal: AbortSignal;
  event(value: unknown): void;
  readonly watches: Map<number, WorkspaceWatch>;
}

export function isWorkspaceRequest(request: FrameRequest): request is WorkspaceRequest {
  return request.type.startsWith("workspace.");
}

export async function dispatchWorkspace(request: WorkspaceRequest, context: WorkspaceDispatch): Promise<unknown> {
  const { workspace, signal } = context;
  switch (request.type) {
    case "workspace.read": return workspace.readFile(request.path, signal);
    case "workspace.readText": return workspace.readText(request.path, signal);
    case "workspace.write": return workspace.writeFile(request.path, request.data, signal);
    case "workspace.writeText": return workspace.writeText(request.path, request.data, signal);
    case "workspace.list": return (await workspace.list(request.path, signal)).map(entry => ({ kind: entry.kind, name: entry.name, path: entry.path }));
    case "workspace.remove": return workspace.remove(request.path, { recursive: request.recursive, signal });
    case "workspace.entries": return (await workspace.entries(request.path, signal)).map(encodeFileEntry);
    case "workspace.stat": return encodeFileEntry(await workspace.stat(request.path, signal));
    case "workspace.readEntry": {
      const file = await workspace.read(request.path, { ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }), signal });
      return { entry: encodeFileEntry(file.entry), data: file.data };
    }
    case "workspace.writeEntry":
      return encodeFileEntry(await workspace.write(request.path, request.data, { ...(request.ifVersion === undefined ? {} : { ifVersion: request.ifVersion }), signal }));
    case "workspace.createDirectory": return workspace.createDirectory(request.path, { signal });
    case "workspace.rename": return workspace.rename(request.from, request.to, { signal });
    case "workspace.watch": {
      const watch = workspace.watch(changes => context.event(encodeWorkspaceChanges(changes)), { signal });
      context.watches.set(request.id, watch);
      try { await watch.done; } finally { context.watches.delete(request.id); }
      return undefined;
    }
    case "workspace.watch.setDirectories": {
      const watch = context.watches.get(request.watch);
      if (watch === undefined) throw new VMError("ABORTED", "workspace watch has ended");
      return watch.setDirectories(request.directories);
    }
  }
}
