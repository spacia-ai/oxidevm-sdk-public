import { VMError } from "../runtime/errors.js";
import type {SnapshotBrowser} from "../snapshot-authoring.js";
export interface SnapshotBrowserRunner {
  runSnapshotBrowser(options:{readonly origin:string;readonly browser:SnapshotBrowser;readonly profile:string;readonly timeoutMs:number;readonly signal?:AbortSignal}):Promise<unknown>;
}
export async function loadSnapshotBrowserRunner():Promise<SnapshotBrowserRunner> {
  const module:unknown=await import(new URL("../browser-tools/snapshot-browser.js",import.meta.url).href);
  if(!isSnapshotRunner(module))throw new VMError("FEATURE_NOT_AVAILABLE","SDK snapshot browser adapter is unavailable");
  return module;
}
function isSnapshotRunner(value:unknown):value is SnapshotBrowserRunner {
  return typeof value==="object"&&value!==null&&"runSnapshotBrowser" in value&&typeof value.runSnapshotBrowser==="function";
}
export interface ImageBrowserRunner {
  runImageBrowser(origin: string, browser: "chromium" | "firefox" | "webkit", profile: string, signal?: AbortSignal): Promise<unknown>;
}
function isRunner(value: unknown): value is ImageBrowserRunner {
  return typeof value === "object" && value !== null && "runImageBrowser" in value && typeof value.runImageBrowser === "function";
}
/** A separately checked browser tooling graph keeps Playwright's DOM types out of the Node API. */
export async function loadImageBrowserRunner(): Promise<ImageBrowserRunner> {
  const location = new URL("../browser-tools/image-browser.js", import.meta.url);
  const module: unknown = await import(location.href);
  if (!isRunner(module)) throw new VMError("FEATURE_NOT_AVAILABLE", "SDK browser automation adapter is unavailable");
  return module;
}
