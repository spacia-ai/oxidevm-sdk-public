import type { NetworkOptions } from "../../contracts.js";
import { defineImage, decodeTrustedImageKey } from "../../image.js";
import type { ImageRef } from "../../image.js";
import { exactKeys, record, string } from "../../runtime/decode.js";
import { serializeRelayOptions } from "../../runtime/protocol/network.js";
import { VMError } from "../../runtime/errors.js";
import type { RuntimeMode } from "../../values.js";
import { builtInCommandInterceptors, decodePublicVMOptions } from "../../vm-options.js";
import {decodeSerializedShippedSnapshot, serializeShippedSnapshot} from "../../runtime/protocol/shipped-source.js";
import type { ValidatedVMOptions } from "../../vm-options.js";

// The options a page passes to createVM, as they cross into the runtime frame. The page validates
// them first (decodePublicVMOptions) so mistakes fail where they were made; the frame validates
// them again with the same decoder, because the port is a trust boundary. Everything relative is
// made absolute against the page first: the frame lives on another origin. Callbacks and the
// abort signal stay in the page; they travel as events and cancel messages.

export interface FrameImageLocation {
  readonly mode: RuntimeMode;
  readonly manifestUrl: string;
  readonly manifestSHA256: string;
  readonly trust: { readonly algorithm: "Ed25519"; readonly keyId: string; readonly publicKey: string };
}

const COMMON_KEYS = ["workspaceId", "memoryMiB", "network", "preview", "image", "license", "shippedSnapshot", "imagePreparation"] as const;

/** The wire form of validated options, in the public option names. An ephemeral workspace keeps no ID: the frame picks one. */
export function encodeFrameOptions(options: ValidatedVMOptions, page: string): Readonly<Record<string, unknown>> {
  const image = options.image === undefined ? undefined : encodeImage(options.image, page);
  const common = {
    mode: options.mode,
    restorePoint: options.resume,
    imagePreparation: options.imagePreparation,
    ...(options.shipped===undefined?{}:{shippedSnapshot:typeof options.shipped === "string" ? options.shipped : serializeShippedSnapshot(options.shipped,page)}),
    ...(options.ephemeral ? {} : { workspaceId: options.workspaceId }),
    ...(options.memoryMiB === undefined ? {} : { memoryMiB: options.memoryMiB }),
    network: encodeNetwork(options.network, page),
    ...(options.preview === undefined ? {} : { preview: { ...options.preview } }),
    ...(image === undefined ? {} : { image }),
    // The token travels inside the connected port only, never in the frame's URL.
    ...(options.runtime.license === undefined ? {} : { license: options.runtime.license }),
  };
  if (options.mode === "system") return { ...common, vcpus: options.vcpus };
  return { ...common, commandInterceptors: builtInCommandInterceptors(options), ...(options.processLimitExplicit ? { limits: { maxProcesses: options.limits.maxProcesses } } : {}),
    ...(options.initialUser === undefined ? {} : { initialUser: options.initialUser }), ...(options.rootPersistence === undefined ? {} : { rootPersistence: options.rootPersistence }) };
}

/**
 * Decodes the wire options inside the frame and validates them exactly as a self-hosted page
 * would, with the frame's own engine copy at `baseUrl`.
 */
export function decodeFrameOptions(value: unknown, baseUrl: string): ValidatedVMOptions {
  const options = record(value, "frame VM options");
  const mode = options["mode"];
  if (mode !== "system" && mode !== "userspace") throw new VMError("PROTOCOL_ERROR", "frame VM mode is invalid");
  exactKeys(options, ["mode", "network"], [...COMMON_KEYS, ...(mode === "system" ? ["vcpus", "restorePoint"] : ["limits", "initialUser", "rootPersistence", "restorePoint", "commandInterceptors"])]);
  const commands = options["commandInterceptors"];
  if (commands !== undefined && commands !== "auto" && commands !== "off") throw new VMError("PROTOCOL_ERROR", "The runtime frame accepts only built-in interceptor workers");
  const image = options["image"] === undefined ? undefined : decodeImage(options["image"], mode);
  const { license, ...rest } = options;
  const shipped = options["shippedSnapshot"];
  const input: Readonly<Record<string, unknown>> = {
    ...rest,
    ...(shipped === undefined || typeof shipped === "string" ? {} : {shippedSnapshot:decodeSerializedShippedSnapshot(shipped)}),
    ...(image === undefined ? {} : { image }),
    runtime: { hosting: "self-hosted", baseUrl, ...(license === undefined ? {} : { license }) },
  };
  return decodePublicVMOptions(input);
}

function encodeImage(image: ImageRef<RuntimeMode>, page: string): FrameImageLocation {
  return { mode: image.mode, manifestUrl: new URL(image.manifestUrl, page).href, manifestSHA256: image.manifestSHA256, trust: { ...image.trust } };
}

function decodeImage(value: unknown, mode: RuntimeMode): ImageRef<RuntimeMode> {
  const image = record(value, "frame image");
  exactKeys(image, ["mode", "manifestUrl", "manifestSHA256", "trust"]);
  if (image["mode"] !== mode) throw new VMError("PROTOCOL_ERROR", "frame image mode does not match the VM mode");
  const manifestUrl = string(image["manifestUrl"], "frame image manifest URL");
  if (!/^https?:\/\//u.test(manifestUrl)) throw new VMError("PROTOCOL_ERROR", "frame image manifest URL must be absolute");
  return defineImage({ mode, manifestUrl, manifestSHA256: string(image["manifestSHA256"], "frame image digest"), trust: decodeTrustedImageKey(image["trust"]) });
}

function encodeNetwork(network: NetworkOptions, page: string): NetworkOptions {
  if (network.mode === "local") return { mode: "local" };
  return { mode: "relay", connection: serializeRelayOptions(network.connection, page) };
}
