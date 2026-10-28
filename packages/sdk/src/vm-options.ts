import { decodeCommandInterceptors } from "./command-interceptors.js";
import type { CommandInterceptorRecord } from "./command-interceptors.js";
import {decodeShippedName} from "./runtime/managed-start.js";
import {decodeManagedResume} from "./runtime/protocol/start-image.js";
import { decodeImagePreparation } from "./runtime/protocol/image-preparation.js";
import type { ImagePreparation } from "./values.js";
import type { BootProgress, CreateVMOptions, ManagedResume, NetworkOptions, PreviewOptions, RelayConnectionOptions } from "./contracts.js";
import { isImageRef } from "./image.js";
import {isShippedSnapshotRef, type ShippedSnapshotRef} from "./shipped-snapshot.js";
import { VMError } from "./runtime/errors.js";
import { isTrustworthyURL } from "./trustworthy-url.js";
import { exactKeys, integer, record, string } from "./runtime/decode.js";
import { decodeRelayOptions } from "./runtime/protocol/network.js";
import { validateWorkspaceId } from "./runtime/workspace-path.js";

/** Validates relative URLs without reading browser state. */
const REFERENCE_BASE = "https://oxidevm-reference.invalid/";

/** Where a self-hosted page serves the engine release by default. */
export const DEFAULT_SELF_HOSTED_BASE_URL = "/oxidevm/runtime/";
/** Spacia's hosted runtime frame (ADR 0021). */
export const DEFAULT_FRAME_ORIGIN = "https://run.oxidevm.dev";
/** Where previews of VMs in Spacia's frame live: one https://<session>.oxvm.dev origin each. */
export const DEFAULT_FRAME_PREVIEW_ORIGIN = "https://oxvm.dev";

/** Where the runtime runs: a hidden frame on the runtime origin, or this page with its own engine copy. */
export type RuntimeSelection =
  | { readonly hosting: "frame"; readonly origin: string; readonly license?: string }
  | { readonly hosting: "self-hosted"; readonly baseUrl: string; readonly license?: string };

const LICENSE_TOKEN = /^oxl1\.[A-Za-z0-9_-]{1,4000}\.[A-Za-z0-9_-]{86}$/u;

interface ValidatedCommon {
  readonly imagePreparation: ImagePreparation;
  readonly workspaceId: string;
  readonly ephemeral: boolean;
  readonly memoryMiB?: number;
  readonly runtime: RuntimeSelection;
  readonly network: NetworkOptions;
  readonly preview?: PreviewOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BootProgress) => void;
}
export type ValidatedVMOptions = ValidatedCommon & (
  | { readonly mode: "system"; readonly shipped?: string | ShippedSnapshotRef<"system">; readonly image?: Extract<CreateVMOptions, { mode: "system" }>["image"]; readonly vcpus: 1 | 2 | 3 | 4; readonly resume: ManagedResume }
  | ({ readonly mode: "userspace"; readonly shipped?: string | ShippedSnapshotRef<"userspace">; readonly image?: Extract<CreateVMOptions, { mode: "userspace" }>["image"]; readonly limits: { readonly maxProcesses: number }; readonly acceleration: "auto" | "off"; readonly interceptors?: false | readonly CommandInterceptorRecord[]; readonly processLimitExplicit: boolean; readonly resume: ManagedResume } & Pick<Extract<CreateVMOptions, { mode: "userspace" }>, "initialUser" | "rootPersistence">)
);

/** Pass the selected recommendation to the existing native descendant-process owner. */
export function resolveProcessLimit(options: Extract<ValidatedVMOptions, { mode: "userspace" }>, recommendation?: number): number {
  return options.processLimitExplicit ? options.limits.maxProcesses : recommendation ?? options.limits.maxProcesses;
}

export function decodePublicVMOptions(input: unknown): ValidatedVMOptions {
  try { return decodeOptions(input); }
  catch (error) {
    if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message);
    throw error;
  }
}

function decodeOptions(input: unknown): ValidatedVMOptions {
  const value = record(input, "VM options");
  const mode = value["mode"];
  if (mode !== "system" && mode !== "userspace") invalid("mode must be system or userspace");
  exactKeys(value, ["mode"], ["workspaceId", "memoryMiB", "runtime", "network", "preview", "signal", "onProgress", "image", "shippedSnapshot", "imagePreparation", ...(mode === "system" ? ["vcpus", "restorePoint"] : ["limits", "initialUser", "rootPersistence", "restorePoint", "commandInterceptors"])]);
  const workspace = value["workspaceId"];
  const signal = value["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid("signal must be an AbortSignal");
  const progress = value["onProgress"];
  if (progress !== undefined && !isProgressListener(progress)) invalid("onProgress must be a function");
  const runtime = decodeRuntime(value["runtime"]);
  // Spacia's frame comes with Spacia's preview origin; any other runtime needs its own.
  const preview = value["preview"] === undefined
    ? runtime.hosting === "frame" && runtime.origin === DEFAULT_FRAME_ORIGIN ? { origin: DEFAULT_FRAME_PREVIEW_ORIGIN, isolation: "per-session" as const } : undefined
    : decodePreview(value["preview"]);
  const common: ValidatedCommon = {
    imagePreparation: decodeImagePreparation(value["imagePreparation"]),
    workspaceId: workspace === undefined ? `ephemeral_${crypto.randomUUID().replaceAll("-", "")}` : validateWorkspaceId(string(workspace, "workspaceId")),
    ephemeral: workspace === undefined,
    runtime,
    network: decodeNetwork(value["network"]),
    ...(value["memoryMiB"] === undefined ? {} : { memoryMiB: integer(value["memoryMiB"], "memoryMiB", 64, 3072) }),
    ...(preview === undefined ? {} : { preview }),
    ...(signal === undefined ? {} : { signal }),
    ...(progress === undefined ? {} : { onProgress: progress }),
  };
  const image = value["image"];
  if (mode === "system") {
    const shipped = decodeShipped(value["shippedSnapshot"], mode);
    if (image !== undefined && !isImageRef(image, mode)) invalid("image must be a system reference returned by defineImage");
    const vcpus = value["vcpus"] ?? 1;
    if (vcpus !== 1 && vcpus !== 2 && vcpus !== 3 && vcpus !== 4) invalid("vcpus must be 1, 2, 3 or 4");
    const resume = value["restorePoint"] ?? "none";
    return { ...common, mode, vcpus, resume: decodeManagedResume(resume), ...(image === undefined ? {} : { image }), ...(shipped === undefined ? {} : {shipped}) };
  }
  const shipped = decodeShipped(value["shippedSnapshot"], mode);
  if (image !== undefined && !isImageRef(image, mode)) invalid("image must be a userspace reference returned by defineImage");
  const limits = value["limits"] === undefined ? {} : record(value["limits"], "limits");
  exactKeys(limits, [], ["maxProcesses"]);
  const commands = decodeCommandInterceptorOption(value["commandInterceptors"]);
  const interceptors = commands.interceptors;
  if (interceptors !== undefined && interceptors !== false && runtime.hosting !== "self-hosted") invalid("Custom command interceptor workers require a self-hosted runtime");
  const initialUser = value["initialUser"], rootPersistence = value["rootPersistence"];
  const acceleration = commands.acceleration;
  if (acceleration === "auto" && initialUser === "root") invalid("Command acceleration requires ordinary credentials; use commandInterceptors: \"off\" with root");
  if (initialUser !== undefined && initialUser !== "user" && initialUser !== "root") invalid("initialUser must be user or root");
  if (rootPersistence !== undefined && rootPersistence !== "ephemeral" && rootPersistence !== "persistent") invalid("rootPersistence must be ephemeral or persistent");
  if (rootPersistence === "persistent" && common.ephemeral) invalid("Persistent root storage requires workspaceId");
  return { ...common, mode, acceleration, ...(interceptors === undefined ? {} : { interceptors }), resume: decodeManagedResume(value["restorePoint"] ?? "none"), processLimitExplicit: limits["maxProcesses"] !== undefined, limits: { maxProcesses: integer(limits["maxProcesses"] ?? 32, "maxProcesses", 1, 64) }, ...(image === undefined ? {} : { image }),
    ...(shipped === undefined ? {} : {shipped}),
    ...(initialUser === undefined ? {} : { initialUser }), ...(rootPersistence === undefined ? {} : { rootPersistence }) };
}

type CommandInterceptorSettings = ReturnType<typeof decodeCommandInterceptors>;

/**
 * The built-in `commandInterceptors` setting of a validated Userspace configuration. Custom interceptor workers are
 * not part of this form: the runtime frame and the snapshot configuration have always carried only the built-in setting.
 */
export function builtInCommandInterceptors(options: Extract<ValidatedVMOptions, { readonly mode: "userspace" }>): "auto" | "off" {
  return options.acceleration === "off" ? "off" : "auto";
}

/**
 * The public `commandInterceptors` option as the settings it selects: "auto" accelerates qualified commands,
 * "off" disables acceleration and interceptors, and an array installs custom interceptor workers, which also
 * accelerate qualified commands unless the runtime is root.
 */
function decodeCommandInterceptorOption(input: unknown): { readonly acceleration: "auto" | "off"; readonly interceptors?: false | CommandInterceptorSettings } {
  if (input === undefined || input === "auto") return { acceleration: "auto" };
  if (input === "off") return { acceleration: "off", interceptors: false };
  return { acceleration: "auto", interceptors: decodeCommandInterceptors(input) };
}

function decodeShipped<M extends "system" | "userspace">(value: unknown, mode: M): string | ShippedSnapshotRef<M> | undefined {
  return isShippedSnapshotRef(value, mode) ? value : decodeShippedName(value);
}

/** A public `runtime` option on its own (as `eraseLocalData` takes it); a mistake is INVALID_ARGUMENT. */
export function decodePublicRuntime(input: unknown): RuntimeSelection {
  try { return decodeRuntime(input); }
  catch (error) {
    if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message);
    throw error;
  }
}

/** `{ baseUrl }` without a hosting key is the pre-frame shape; it stays self-hosted until the next alpha. */
function decodeRuntime(input: unknown): RuntimeSelection {
  if (input === undefined) return { hosting: "self-hosted", baseUrl: DEFAULT_SELF_HOSTED_BASE_URL };
  const value = record(input, "runtime");
  const license = value["license"] === undefined ? {} : { license: decodeLicense(value["license"]) };
  if (value["hosting"] === "frame") {
    exactKeys(value, ["hosting"], ["origin", "license"]);
    return { hosting: "frame", origin: value["origin"] === undefined ? DEFAULT_FRAME_ORIGIN : originOnly(value["origin"], "runtime.origin"), ...license };
  }
  if (value["hosting"] === "self-hosted") exactKeys(value, ["hosting", "baseUrl"], ["license"]);
  else if (value["hosting"] === undefined) exactKeys(value, ["baseUrl"]);
  else invalid("runtime.hosting must be frame or self-hosted");
  const baseUrl = location(value["baseUrl"], "runtime.baseUrl");
  return { hosting: "self-hosted", baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`, ...license };
}

function decodeLicense(input: unknown): string {
  if (typeof input !== "string" || !LICENSE_TOKEN.test(input)) invalid("runtime.license must be an oxl1 license token");
  return input;
}

function decodeNetwork(input: unknown): NetworkOptions {
  if (input === undefined) return { mode: "local" };
  const value = record(input, "network");
  if (value["mode"] === "local") { exactKeys(value, ["mode"]); return { mode: "local" }; }
  if (value["mode"] !== "relay") invalid("network.mode must be local or relay");
  exactKeys(value, ["mode", "connection"]);
  return { mode: "relay", connection: decodeConnection(value["connection"]) };
}
/** An owned copy checked by the relay owner's own decoder. A relative sessionUrl stays relative:
 * the owner resolves it against the page when it connects. */
function decodeConnection(input: unknown): RelayConnectionOptions {
  const decoded = decodeRelayOptions(input, REFERENCE_BASE);
  if (decoded.kind === "personal") return decoded;
  const sessionUrl = record(input, "network.connection")["sessionUrl"];
  return typeof sessionUrl === "string" ? { ...decoded, sessionUrl } : decoded;
}
function decodePreview(input: unknown): PreviewOptions {
  const value = record(input, "preview");
  exactKeys(value, ["origin", "isolation"], value["isolation"] === "shared" ? ["developmentOnly"] : []);
  const origin = originOnly(value["origin"], "preview.origin");
  if (value["isolation"] === "per-session") return { origin, isolation: "per-session" };
  if (value["isolation"] !== "shared" || value["developmentOnly"] !== true) invalid("shared preview isolation requires developmentOnly: true");
  return { origin, isolation: "shared", developmentOnly: true };
}
function originOnly(input: unknown, field: string): string {
  const url = new URL(location(input, field, false));
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") invalid(`${field} must contain only an origin`);
  return url.origin;
}
function location(input: unknown, field: string, relative = true): string {
  const text = input instanceof URL ? input.href : string(input, field);
  const originRelative = relative && text.startsWith("/") && !text.startsWith("//");
  let url: URL; try { url = new URL(text, REFERENCE_BASE); } catch { return invalid(`${field} must be a URL`); }
  if (!isTrustworthy(url, "https:", "http:") || url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "" || Array.from(text).some(char => char.charCodeAt(0) <= 32 || char === "\\")) invalid(`${field} must be a trustworthy URL`);
  if (!originRelative && !/^https?:\/\//u.test(text)) invalid(`${field} must be absolute or origin-relative`);
  return originRelative ? text : url.href;
}
function isTrustworthy(url: URL, secure: string, insecure: string): boolean {
  return isTrustworthyURL(url, secure, insecure);
}

function isProgressListener(input: unknown): input is (progress: BootProgress) => void { return typeof input === "function"; }
function invalid(message: string): never { throw new VMError("INVALID_ARGUMENT", message); }
