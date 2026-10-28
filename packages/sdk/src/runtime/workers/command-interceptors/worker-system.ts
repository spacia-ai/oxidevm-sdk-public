import { sha256 } from "@noble/hashes/sha2.js";
import { serveProcess, LinuxError, type LinuxProcessContext, type LinuxProcessInfo } from "../../../js-process.js";
import { integer } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { LinuxFileStat } from "../../../js-process-types.js";
import { TYPESCRIPT } from "../../command-interceptor-identity.js";

class CompilerExit extends Error { constructor(readonly code: number) { super("Compiler exit"); } }

/** Only the authenticated compiler executes. Project files remain compiler input data. */
export function serveTypeScript(run: (system: TypeScriptSystem) => void): void {
  serveProcess(async context => {
    const info = await context.process.info();
    if (info.args.length !== 1 || info.args[0] !== "--noEmit") throw new VMError("FEATURE_NOT_AVAILABLE", "This compiler worker supports only --noEmit");
    const entry = resolveCompilerEntry(context.filesSync.readFile("/proc/self/cmdline"), path => context.filesSync.realpath(path));
    const system = new TypeScriptSystem(context, info, entry);
    for (const { path, sha256, name } of Object.values(TYPESCRIPT.files)) {
      const failure = () => new VMError("FEATURE_NOT_AVAILABLE", `Installed TypeScript ${name} differs from the bundled compiler`);
      let bytes: Uint8Array;
      try { bytes = context.filesSync.readFile(entry.replace(/bin\/tsc$/u, path)); }
      catch (error) { if (error instanceof LinuxError && error.errno === 2) throw failure(); throw error; }
      if (digest(bytes) !== sha256) throw failure();
    }
    try { run(system); return 0; } catch (error) { if (error instanceof CompilerExit) return error.code; throw error; }
  });
}

/** Retain the admitted process's actual compiler path for authentication and lib resolution. */
export function resolveCompilerEntry(commandLine: Uint8Array, realpath: (path: string) => string): string {
  const args = new TextDecoder().decode(commandLine).split("\0");
  const script = args[1];
  if (args.length !== 4 || args[3] !== "" || args[2] !== "--noEmit" || script === undefined || script === "") throw new VMError("FEATURE_NOT_AVAILABLE", "Invalid intercepted compiler command line");
  const entry = realpath(script);
  if (!TYPESCRIPT.entries.some(allowed => allowed === entry)) throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported intercepted compiler path");
  return entry;
}

export class TypeScriptSystem {
  readonly newLine = "\n";
  readonly useCaseSensitiveFileNames = true;
  readonly args: readonly string[];
  constructor(readonly context: LinuxProcessContext, readonly info: LinuxProcessInfo, readonly entry: string) { this.args = info.args; }
  #stat(path: string): LinuxFileStat | undefined {
    try { return this.context.filesSync.stat(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  readFile = (path: string): string | undefined => {
    try {
      const bytes = this.context.filesSync.readFile(path);
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
      return new TextDecoder().decode(bytes).replace(/^\uFEFF/u, "");
    } catch (error) { if (missing(error)) return undefined; throw error; }
  };
  writeFile = (path: string, text: string, bom?: boolean): void => { this.context.filesSync.writeFile(path, new TextEncoder().encode((bom === true ? "\uFEFF" : "") + text)); };
  fileExists = (path: string): boolean => { const stat = this.#stat(path); return stat !== undefined && (stat.mode & 0o170000) === 0o100000; };
  directoryExists = (path: string): boolean => { const stat = this.#stat(path); return stat !== undefined && (stat.mode & 0o170000) === 0o040000; };
  getFileSystemEntries(path: string): { files: string[]; directories: string[] } {
    try {
      const files: string[] = [], directories: string[] = [];
      for (const entry of this.context.filesSync.readdir(path)) {
        const mode = entry.type === 4 ? 0o040000 : entry.type === 8 ? 0o100000 : (this.#stat(`${path}/${entry.name}`)?.mode ?? 0) & 0o170000;
        if (mode === 0o040000) directories.push(entry.name); else if (mode === 0o100000) files.push(entry.name);
      }
      return { files: files.sort(), directories: directories.sort() };
    } catch (error) { if (missing(error)) return { files: [], directories: [] }; throw error; }
  }
  getDirectories = (path: string): string[] => this.getFileSystemEntries(path).directories;
  createDirectory = (path: string): void => { if (!this.directoryExists(path)) this.context.filesSync.mkdir(path); };
  realpath = (path: string): string => { try { return this.context.filesSync.realpath(path); } catch (error) { if (missing(error)) return this.resolvePath(path); throw error; } };
  resolvePath = (path: string): string => {
    const parts: string[] = [];
    for (const part of (path.startsWith("/") ? path : `${this.info.cwd}/${path}`).split("/")) { if (part === "..") parts.pop(); else if (part !== "" && part !== ".") parts.push(part); }
    return `/${parts.join("/")}`;
  };
  getCurrentDirectory = (): string => this.info.cwd;
  getExecutingFilePath = (): string => this.entry.replace(/\/bin\/tsc$/u, "/lib/_tsc.js");
  getEnvironmentVariable = (name: string): string => this.info.environment.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
  writeOutputIsTTY = (): boolean => this.info.terminal !== null;
  getWidthOfTerminal = (): number => this.info.terminal?.columns ?? 0;
  getModifiedTime = (path: string): Date | undefined => { const stat = this.#stat(path); return stat === undefined ? undefined : new Date(Number(stat.modifiedNs / 1_000_000n)); };
  deleteFile = (path: string): void => this.context.filesSync.unlink(path);
  createHash = (text: string): string => digest(new TextEncoder().encode(text));
  write = (text: string): void => this.context.filesSync.writeAll(this.context.stdout, new TextEncoder().encode(text));
  exit = (code: number): never => { throw new CompilerExit(integer(code, "compiler exit status", 0, 255)); };
}
function missing(error: unknown): boolean { return error instanceof LinuxError && [2, 13, 20, 21, 40].includes(error.errno); }
function digest(bytes: Uint8Array): string { return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, "0")).join(""); }
