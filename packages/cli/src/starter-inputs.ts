import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VMError } from "@oxidevm/sdk";
import { fields, object, text } from "./validation.js";

/** Private distribution supplies this profile beside the launcher, never in application source. */
export async function readStarterInputs(directory: string, version: string) {
  const path = join(directory, ".oxidevm/starter.json");
  const bytes = await readFile(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (bytes === undefined) return undefined;
  if (bytes.length > 16 * 1024) throw new VMError("PROTOCOL_ERROR", "Starter profile exceeds its limit");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  const profile = object(value, "starter profile");
  fields(profile, ["schemaVersion", "sdkVersion", "image", "engineDir", "archives"], ["engineComplianceDir"]);
  if (profile["schemaVersion"] !== 1) throw new VMError("PROTOCOL_ERROR", "Unsupported starter profile");
  if (profile["sdkVersion"] !== version) throw new VMError("INVALID_ARGUMENT", "The private starter profile must match this exact SDK and CLI version");
  const image = object(profile["image"], "starter image"); fields(image, ["bundle", "trust"]);
  const archives = object(profile["archives"], "starter archives"); fields(archives, ["sdk", "cli"]);
  const local = (value: unknown) => resolve(dirname(path), text(value));
  return { image: { bundle: local(image["bundle"]), trust: local(image["trust"]) }, engineDir: local(profile["engineDir"]), ...(profile["engineComplianceDir"] === undefined ? {} : { engineComplianceDir: local(profile["engineComplianceDir"]) }), archives: { sdk: local(archives["sdk"]), cli: local(archives["cli"]) } };
}
