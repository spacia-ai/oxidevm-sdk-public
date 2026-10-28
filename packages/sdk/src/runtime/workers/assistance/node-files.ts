import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { Dirent, fileAccessConstants, createFileOperations, type FileOperation } from "./node-file-operations.js";

export { createAsyncFiles } from "./node-files-async.js";

export function createSyncFiles(call: (operation: AssistanceOperation) => AssistanceResult, cwd: () => string, copyOpenMode?: 10) {
  const operations = createFileOperations(cwd, false, copyOpenMode);
  function run<Result>(program: FileOperation<Result>): Result {
    let step = program.next();
    while (step.done !== true) {
      let result: AssistanceResult;
      try { result = call(step.value); }
      catch (error) { step = program.throw(error); continue; }
      step = program.next(result);
    }
    return step.value;
  }
  return {
    Dirent, constants: fileAccessConstants,
    accessSync: (...args: Parameters<typeof operations.access>) => run(operations.access(...args)),
    openSync: (...args: Parameters<typeof operations.open>) => run(operations.open(...args)),
    closeSync: (...args: Parameters<typeof operations.close>) => run(operations.close(...args)),
    readSync: (...args: Parameters<typeof operations.read>) => run(operations.read(...args)),
    writeSync: (...args: Parameters<typeof operations.write>) => run(operations.write(...args)),
    readFileSync: (...args: Parameters<typeof operations.readFile>) => run(operations.readFile(...args)),
    statSync: (...args: Parameters<typeof operations.stat>) => run(operations.stat(...args)),
    // Node's existsSync answers false for every failure, including invalid arguments.
    existsSync: (path: unknown): boolean => { try { run(operations.access(path)); return true; } catch { return false; } },
    lstatSync: (...args: Parameters<typeof operations.lstat>) => run(operations.lstat(...args)),
    fstatSync: (...args: Parameters<typeof operations.fstat>) => run(operations.fstat(...args)),
    writeFileSync: (...args: Parameters<typeof operations.writeFile>) => run(operations.writeFile(...args)),
    appendFileSync: (...args: Parameters<typeof operations.appendFile>) => run(operations.appendFile(...args)),
    fsyncSync: (...args: Parameters<typeof operations.fsync>) => run(operations.fsync(...args)),
    fdatasyncSync: (...args: Parameters<typeof operations.fdatasync>) => run(operations.fdatasync(...args)),
    unlinkSync: (...args: Parameters<typeof operations.unlink>) => run(operations.unlink(...args)),
    copyFileSync: (...args: Parameters<typeof operations.copyFile>) => run(operations.copyFile(...args)),
    rmSync: (...args: Parameters<typeof operations.rm>) => run(operations.rm(...args)),
    rmdirSync: (...args: Parameters<typeof operations.rmdir>) => run(operations.rmdir(...args)),
    mkdirSync: (...args: Parameters<typeof operations.mkdir>) => run(operations.mkdir(...args)).path,
    chmodSync: (...args: Parameters<typeof operations.chmod>) => run(operations.chmod(...args)),
    fchmodSync: (...args: Parameters<typeof operations.fchmod>) => run(operations.fchmod(...args)),
    truncateSync: (...args: Parameters<typeof operations.truncate>) => run(operations.truncate(...args)),
    ftruncateSync: (...args: Parameters<typeof operations.ftruncate>) => run(operations.ftruncate(...args)),
    renameSync: (...args: Parameters<typeof operations.rename>) => run(operations.rename(...args)),
    linkSync: (...args: Parameters<typeof operations.link>) => run(operations.link(...args)),
    symlinkSync: (...args: Parameters<typeof operations.symlink>) => run(operations.symlink(...args)),
    readlinkSync: (...args: Parameters<typeof operations.readlink>) => run(operations.readlink(...args)),
    realpathSync: (...args: Parameters<typeof operations.realpath>) => run(operations.realpath(...args)),
    readdirSync: (...args: Parameters<typeof operations.readdir>) => run(operations.readdir(...args)),
  };
}
