import type {ExecResult, ExecSpec, ListeningPort, PipeSpawnSpec, RunningProcess, TerminalHandle, TerminalSpawnSpec, VM} from "./contracts.js";

export type SnapshotBrowser = "chromium" | "firefox" | "webkit";
export type SnapshotPhase = "validate" | "compile" | "start" | "stage" | "prepare" | "ready" | "capture" | "export" | "package" | "verify" | "publish" | "done";
export interface SnapshotTimeouts {
  readonly buildMs?: number;
  readonly commandMs?: number;
  readonly readyMs?: number;
  readonly captureMs?: number;
  readonly verifyMs?: number;
}
export type SnapshotWorkload = {readonly module: string; readonly shell?: never} | {readonly shell: string; readonly module?: never};
export type SnapshotData = null | boolean | number | string | readonly SnapshotData[] | {readonly [key: string]: SnapshotData};
export interface SnapshotWaitOptions {readonly timeoutMs?: number; readonly signal?: AbortSignal}
export interface SnapshotProcessBase extends Pick<RunningProcess, "pid" | "stdin" | "exit" | "kill"> {
  readonly name: string;
  readonly snapshotKey: string;
  waitForOutput(text: string, options?: SnapshotWaitOptions): Promise<void>;
}
export type SnapshotProcess =
  | (SnapshotProcessBase & {readonly kind: "process"})
  | (SnapshotProcessBase & {readonly kind: "terminal"; readonly resize: TerminalHandle["resize"]; readonly interrupt: TerminalHandle["interrupt"]});
export interface SnapshotContext {
  readonly vm: VM;
  readonly signal: AbortSignal;
  run: (spec: ExecSpec & {readonly timeoutMs?: number; readonly expectedExitCode?: number}) => Promise<ExecResult>;
  waitForPort: (port: number, options?: SnapshotWaitOptions) => Promise<ListeningPort>;
  waitForHTTP: (options: SnapshotWaitOptions & {readonly port: number; readonly path?: string; readonly status?: number; readonly bodyIncludes?: string}) => Promise<{readonly status: number; readonly body: string}>;
  waitUntil: (label: string, predicate: () => boolean | Promise<boolean>, options?: SnapshotWaitOptions) => Promise<void>;
  log: (level: "info" | "warn", message: string) => void;
}
export interface SnapshotPreparationContext extends SnapshotContext {
  start: {
    (name:string,spec:PipeSpawnSpec):Promise<Extract<SnapshotProcess,{kind:"process"}>>;
    (name:string,spec:TerminalSpawnSpec):Promise<Extract<SnapshotProcess,{kind:"terminal"}>>;
  };
}
export interface SnapshotVerificationContext extends SnapshotContext {
  readonly data: unknown;
  attach: (name: string) => Promise<SnapshotProcess>;
}
export type PrepareSnapshot = (context: SnapshotPreparationContext) => Promise<SnapshotData | Awaited<Promise<void>>>;
export type VerifySnapshot = (context: SnapshotVerificationContext) => Promise<void>;
