/** Downloads a reader takes in a known order, fetched up to a fixed number ahead of it. */
export interface OrderedDownloads<K, V> {
  /**
   * The value of `key`. A key of the plan waits for its download, which starts the next one; a
   * key outside the plan, or taken a second time, is fetched alone. The first failure of any
   * download cancels the others and is what every later `take` throws.
   */
  take(key: K): Promise<V>;
  /** Cancels what is still downloading and waits until every download has settled. */
  close(): Promise<void>;
}

/**
 * Starts fetching `plan` in order, keeping at most `inFlight` downloads started and not yet both
 * finished and taken. Each download gets a signal that `signal`, the first failure or `close`
 * aborts.
 */
export function orderedDownloads<K, V>(
  plan: readonly K[],
  fetch: (key: K, signal: AbortSignal) => Promise<V>,
  inFlight: number,
  signal: AbortSignal,
): OrderedDownloads<K, V> {
  if (!Number.isSafeInteger(inFlight) || inFlight < 1) throw new RangeError("orderedDownloads needs at least one download in flight");
  const controller = new AbortController();
  const scoped = AbortSignal.any([signal, controller.signal]);
  const started = new Map<K, Promise<V>>();
  const settling = new Set<Promise<unknown>>();
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  // Read through a call: a download can fail while `take` awaits, which narrowing cannot see.
  const failed = (): { readonly error: unknown } | undefined => failure;

  const start = (key: K): Promise<V> => {
    const download = Promise.resolve().then(() => fetch(key, scoped));
    const settled = download.then(() => undefined, (error: unknown) => {
      failure ??= { error };
      controller.abort();
    });
    settling.add(settled);
    void settled.finally(() => settling.delete(settled));
    return download;
  };
  const fill = (): void => {
    while (failure === undefined && next < plan.length && started.size < inFlight) {
      const key = plan[next++];
      if (key !== undefined && !started.has(key)) started.set(key, start(key));
    }
  };
  fill();

  return {
    async take(key) {
      const before = failed();
      if (before !== undefined) throw before.error;
      const download = started.get(key) ?? start(key);
      try {
        return await download;
      } catch (error) {
        throw failed()?.error ?? error;
      } finally {
        // Its slot frees once it is taken and finished, so no more than `inFlight` ever download.
        started.delete(key);
        fill();
      }
    },
    async close() {
      controller.abort();
      started.clear();
      await Promise.all([...settling]);
    },
  };
}
