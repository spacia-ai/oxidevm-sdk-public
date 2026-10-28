import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { AsyncContext } from "./async-context.js";
import { fileAccessConstants, createFileOperations, type FileOperation } from "./node-file-operations.js";

/** Only the driver differs from fs.*Sync: completion resumes the same operation
 * program, including descriptor cleanup after a transport or Linux failure. */
export function createAsyncFiles(
  call: (operation: AssistanceOperation) => Promise<AssistanceResult>,
  cwd: () => string,
  context: AsyncContext,
  retain: () => () => void,
  dispatch: (callback: () => void) => void = callback => callback(),
  copyOpenMode?: 10,
) {
  const operations = createFileOperations(cwd, true, copyOpenMode);
  async function run<Result>(program: FileOperation<Result>, initial?: IteratorResult<AssistanceOperation, Result>): Promise<Result> {
    const release = retain();
    try {
      let step = initial ?? program.next();
      while (step.done !== true) {
        let result: AssistanceResult;
        try { result = await call(step.value); }
        catch (error) { step = program.throw(error); continue; }
        step = program.next(result);
      }
      return step.value;
    } finally { release(); }
  }
  function fileHandle(descriptor: number) {
    let closing: Promise<void> | undefined;
    let pending = 0;
    let idle: PromiseWithResolvers<undefined> | undefined;
    async function perform<Result>(operation: () => FileOperation<Result>): Promise<Result> {
      if (closing !== undefined) throw Object.assign(new Error("EBADF: file handle is closed"), { code: "EBADF", errno: -9 });
      pending += 1;
      try { return await run(operation()); }
      finally { if (--pending === 0) { idle?.resolve(undefined); idle = undefined; } }
    }
    function bind<Args extends readonly unknown[], Result>(operation: (fd: number, ...args: Args) => FileOperation<Result>) {
      return (...args: Args) => perform(() => operation(descriptor, ...args));
    }
    const read = bind(operations.read);
    const write = bind(operations.write);
    return {
      get fd() { return closing === undefined ? descriptor : -1; },
      close(...args: unknown[]): Promise<void> {
        if (args.length !== 0) return Promise.reject(new TypeError("Unsupported file handle close arguments"));
        closing ??= (async () => {
          if (pending !== 0) { idle ??= Promise.withResolvers<undefined>(); await idle.promise; }
          await run(operations.close(descriptor));
        })();
        return closing;
      },
      async read(...args: Parameters<typeof read>) {
        const bytesRead = await read(...args);
        return { bytesRead, buffer: args[0] };
      },
      async write(...args: Parameters<typeof write>) {
        const bytesWritten = await write(...args);
        return { bytesWritten, buffer: args[0] };
      },
      readFile: bind(operations.readFile),
      writeFile: bind(operations.writeFile),
      appendFile: bind(operations.appendFile),
      stat: bind(operations.fstat),
      chmod: bind(operations.fchmod),
      truncate: bind(operations.ftruncate),
      sync: bind(operations.fsync),
      datasync: bind(operations.fdatasync),
    };
  }
  function callback<Result>(
    build: (args: readonly unknown[]) => FileOperation<Result>,
    minimum: number,
    maximum: number,
    values: (result: Result, args: readonly unknown[]) => readonly unknown[] = result => result === undefined ? [] : [result],
  ) {
    return (...args: unknown[]): void => {
      const completion = args.pop();
      if (typeof completion !== "function" || args.length < minimum || args.length > maximum) {
        throw new TypeError("Unsupported filesystem arguments or missing callback");
      }
      const captured = context.capture();
      // Advance validation outside the async driver: Node callback APIs throw
      // argument errors synchronously. Linux failures still use the callback.
      const result = (() => {
        try {
          const program = build(args);
          return run(program, program.next());
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) throw error;
          return Promise.reject(error instanceof Error ? error : new Error("Filesystem operation failed", { cause: error }));
        }
      })();
      void result.then(
        value => dispatch(() => captured(() => { Reflect.apply(completion, undefined, [null, ...values(value, args)]); })),
        (error: unknown) => dispatch(() => captured(() => { Reflect.apply(completion, undefined, [error]); })),
      ).catch((error: unknown) => { queueMicrotask(() => { throw error; }); });
    };
  }
  return {
    promises: {
      constants: fileAccessConstants,
      async access(...args: Parameters<typeof operations.access>) { return run(operations.access(...args)); },
      async open(...args: Parameters<typeof operations.open>) { return fileHandle(await run(operations.open(...args))); },
      async readFile(...args: Parameters<typeof operations.readFile>) { return run(operations.readFile(...args)); },
      async writeFile(...args: Parameters<typeof operations.writeFile>) { return run(operations.writeFile(...args)); },
      async appendFile(...args: Parameters<typeof operations.appendFile>) { return run(operations.appendFile(...args)); },
      async stat(...args: Parameters<typeof operations.stat>) { return run(operations.stat(...args)); },
      async lstat(...args: Parameters<typeof operations.lstat>) { return run(operations.lstat(...args)); },
      async readdir(...args: Parameters<typeof operations.readdir>) { return run(operations.readdir(...args)); },
      async mkdir(...args: Parameters<typeof operations.mkdir>) { return (await run(operations.mkdir(...args))).path; },
      async copyFile(...args: Parameters<typeof operations.copyFile>) { return run(operations.copyFile(...args)); },
      async rm(...args: Parameters<typeof operations.rm>) { return run(operations.rm(...args)); },
      async rmdir(...args: Parameters<typeof operations.rmdir>) { return run(operations.rmdir(...args)); },
      async rename(...args: Parameters<typeof operations.rename>) { return run(operations.rename(...args)); },
      async unlink(...args: Parameters<typeof operations.unlink>) { return run(operations.unlink(...args)); },
      async link(...args: Parameters<typeof operations.link>) { return run(operations.link(...args)); },
      async symlink(...args: Parameters<typeof operations.symlink>) { return run(operations.symlink(...args)); },
      async readlink(...args: Parameters<typeof operations.readlink>) { return run(operations.readlink(...args)); },
      async realpath(...args: Parameters<typeof operations.realpath>) { return run(operations.realpath(...args)); },
      async chmod(...args: Parameters<typeof operations.chmod>) { return run(operations.chmod(...args)); },
      async truncate(...args: Parameters<typeof operations.truncate>) { return run(operations.truncate(...args)); },
    },
    access: callback(args => operations.access(args[0], args[1]), 1, 2, () => []),
    open: callback(args => operations.open(args[0], args[1], args[2]), 1, 3),
    close: callback(args => operations.close(args[0]), 1, 1),
    read: callback(args => operations.read(args[0], args[1], args[2], args[3], args[4]), 4, 5, (count, args) => [count, args[1]]),
    write: callback(args => operations.write(args[0], args[1], args[2], args[3], args[4]), 2, 5, (count, args) => [count, args[1]]),
    readFile: callback(args => operations.readFile(args[0], args[1]), 1, 2),
    writeFile: callback(args => operations.writeFile(args[0], args[1], args[2]), 2, 3),
    appendFile: callback(args => operations.appendFile(args[0], args[1], args[2]), 2, 3),
    stat: callback(args => operations.stat(args[0], args[1]), 1, 2),
    lstat: callback(args => operations.lstat(args[0], args[1]), 1, 2),
    fstat: callback(args => operations.fstat(args[0], args[1]), 1, 2),
    fsync: callback(args => operations.fsync(args[0]), 1, 1),
    fdatasync: callback(args => operations.fdatasync(args[0]), 1, 1),
    readdir: callback(args => operations.readdir(args[0], args[1]), 1, 2),
    mkdir: callback(args => operations.mkdir(args[0], args[1]), 1, 2, result => result.recursive ? [result.path] : []),
    copyFile: callback(args => operations.copyFile(args[0], args[1], args[2]), 2, 3),
    rm: callback(args => operations.rm(args[0], args[1]), 1, 2),
    rmdir: callback(args => operations.rmdir(args[0], args[1]), 1, 2),
    chmod: callback(args => operations.chmod(args[0], args[1]), 2, 2),
    fchmod: callback(args => operations.fchmod(args[0], args[1]), 2, 2),
    truncate: callback(args => operations.truncate(args[0], args[1]), 1, 2),
    ftruncate: callback(args => operations.ftruncate(args[0], args[1]), 1, 2),
    rename: callback(args => operations.rename(args[0], args[1]), 2, 2),
    unlink: callback(args => operations.unlink(args[0]), 1, 1),
    link: callback(args => operations.link(args[0], args[1]), 2, 2),
    symlink: callback(args => operations.symlink(args[0], args[1], args[2]), 2, 3),
    readlink: callback(args => operations.readlink(args[0], args[1]), 1, 2),
    realpath: callback(args => operations.realpath(args[0], args[1]), 1, 2),
  };
}
