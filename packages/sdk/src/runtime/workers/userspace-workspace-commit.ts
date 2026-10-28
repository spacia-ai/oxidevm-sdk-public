/** One commit queue for guest turns, host writes and disposal. */
export async function flushUserspaceFiles(workspace: { flush(): Promise<void> }, root?: { flush(): Promise<void> }): Promise<void> {
  const outcomes = await Promise.allSettled([workspace.flush(), root?.flush() ?? Promise.resolve()]);
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}

export function createUserspaceWorkspaceCommit(persist: () => Promise<void>, failed: (error: unknown) => void) {
  type Batch = ReturnType<typeof Promise.withResolvers<undefined>> & { ready: boolean };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Batch | undefined, pending: Batch | undefined;
  function batch(): Batch {
    const value = { ...Promise.withResolvers<undefined>(), ready: false };
    void value.promise.catch(() => undefined);
    return value;
  }
  function start(): void {
    if (active !== undefined || pending?.ready !== true) return;
    const current = pending; active = current; pending = undefined;
    const settled = (): void => { active = undefined; start(); };
    void Promise.resolve().then(persist).then(() => {
      settled(); current.resolve(undefined);
    }, (error: unknown) => { settled(); current.reject(error); failed(error); });
  }
  function ready(): void {
    clearTimeout(timer); timer = undefined;
    if (pending !== undefined) pending.ready = true;
    start();
  }
  return {
    schedule(): Promise<void> {
      if (pending !== undefined) return pending.promise;
      pending = batch();
      // Preserve the first mutation's deadline, even while another commit runs.
      timer = setTimeout(ready, 250);
      return pending.promise;
    },
    flush(): Promise<void> {
      pending ??= batch();
      const promise = pending.promise;
      ready(); return promise;
    },
    reset(): void {
      if (active !== undefined) throw new Error("Cannot reset an active workspace publication");
      clearTimeout(timer); timer = undefined;
      pending?.reject(new Error("Workspace publication was replaced")); pending = undefined;
    },
  };
}
