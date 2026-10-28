/** Node's `fs.realpathSync.native` and `fs.realpath.native` are the
 * libc-backed variants of the same operation; the assisted runtime's realpath
 * is already answered by Linux, so both members are the implementation itself. */
export function withNativeRealpath<F extends { realpathSync: (...args: unknown[]) => unknown; realpath: (...args: unknown[]) => unknown }>(fs: F): F {
  for (const name of ["realpathSync", "realpath"] as const) {
    const implementation = fs[name];
    if (Reflect.get(implementation, "native") === undefined) {
      Object.defineProperty(implementation, "native", { value: implementation, enumerable: true, configurable: true, writable: true });
    }
  }
  return fs;
}

export function nativeRealpath<T extends (...args: unknown[]) => unknown>(implementation: T): T {
  const native: unknown = Reflect.get(implementation, "native");
  return typeof native === "function" && native === implementation ? implementation : implementation;
}
