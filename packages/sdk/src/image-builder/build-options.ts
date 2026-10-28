import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeImageLocation } from "../image.js";
import type { BuildImageOptions, ImageBuildProgress } from "./contracts.js";

function path(value: unknown, label: string): string {
  const decoded = string(value, label);
  if (decoded.length === 0 || decoded.length > 8192 || decoded.includes("\0")) throw new VMError("INVALID_ARGUMENT", `${label} must be bounded nonempty text`);
  return decoded;
}
function isProgress(value: unknown): value is (progress: ImageBuildProgress) => void { return typeof value === "function"; }

/** JavaScript authors receive the same checks as typed recipe consumers. */
export function decodeBuildImageOptions(value: unknown): BuildImageOptions {
  const input = record(value, "build options");
  exactKeys(input, ["recipeDir", "signingKeyFile"], ["outDir", "publicBaseUrl", "purpose", "secrets", "signal", "onProgress"]);
  const purpose = input["purpose"];
  if (purpose !== undefined && purpose !== "development" && purpose !== "distribution") throw new VMError("INVALID_ARGUMENT", "invalid build purpose");
  const signal = input["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new VMError("INVALID_ARGUMENT", "build signal must be an AbortSignal");
  const progress = input["onProgress"];
  if (progress !== undefined && !isProgress(progress)) throw new VMError("INVALID_ARGUMENT", "build progress must be a callback");
  const base = input["publicBaseUrl"];
  const publicBaseUrl = base === undefined ? undefined : path(base instanceof URL ? base.href : base, "publicBaseUrl");
  if (publicBaseUrl !== undefined) {
    decodeImageLocation(`${publicBaseUrl}manifest.json`);
    if (!publicBaseUrl.endsWith("/") || new URL(publicBaseUrl, "https://image.invalid").search !== "") throw new VMError("INVALID_ARGUMENT", "publicBaseUrl must name a directory URL");
  }
  const supplied = input["secrets"]; let secrets: BuildImageOptions["secrets"];
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || supplied.length > 64) throw new VMError("INVALID_ARGUMENT", "build secrets must be a bounded array");
    const ids = new Set<string>();
    secrets = Array.from<unknown>(supplied).map(value => {
      const item = record(value, "build secret"); exactKeys(item, ["id", "file"]);
      const id = path(item["id"], "secret id"); const file = path(item["file"], "secret file");
      if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(id) || ids.has(id) || file.includes(",") || file.includes("\n") || file.includes("\r")) throw new VMError("INVALID_ARGUMENT", "secret identifiers must be unique and paths must be safe BuildKit arguments");
      ids.add(id); return { id, file };
    });
  }
  return { recipeDir: path(input["recipeDir"], "recipeDir"), signingKeyFile: path(input["signingKeyFile"], "signingKeyFile"),
    ...(input["outDir"] === undefined ? {} : { outDir: path(input["outDir"], "outDir") }),
    ...(purpose === undefined ? {} : { purpose }), ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...(secrets === undefined ? {} : { secrets }), ...(signal === undefined ? {} : { signal }),
    ...(progress === undefined ? {} : { onProgress: progress }) };
}
