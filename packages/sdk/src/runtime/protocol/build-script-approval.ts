import { exactKeys, record, string } from "../decode.ts";
import { VMError } from "../errors.ts";

export interface BuildScriptIdentity {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid build-script approval identity"); }

export function decodeBuildScriptIdentity(value: unknown): BuildScriptIdentity {
  const input = record(value, "build-script identity");
  exactKeys(input, ["name", "version", "integrity"]);
  const name = string(input["name"], "package name");
  const version = string(input["version"], "package version");
  const integrity = string(input["integrity"], "package integrity");
  if (name.length > 2048 || !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)
    || version.length > 256 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)
    || integrity.length > 2048) invalid();
  const tokens = integrity.split(" ");
  if (tokens.length > 8) invalid();
  for (const token of tokens) {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    const algorithm = match?.[1]; const encoded = match?.[2];
    if (algorithm === undefined || encoded === undefined) invalid();
    const length = algorithm === "sha1" ? 20 : algorithm === "sha256" ? 32 : algorithm === "sha384" ? 48 : 64;
    try {
      const bytes = atob(encoded);
      if (bytes.length !== length || btoa(bytes) !== encoded) invalid();
    } catch { invalid(); }
  }
  return { name, version, integrity };
}

export function decodeBlockedBuilds(bytes: Uint8Array): readonly BuildScriptIdentity[] {
  if (bytes.length === 0 || bytes.length > 65_536) invalid();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return invalid(); }
  return decodeBlockedBuildIdentities(value);
}

export function decodeBlockedBuildIdentities(value: unknown): readonly BuildScriptIdentity[] {
  if (!Array.isArray(value) || value.length > 256) invalid();
  let bytes = 2;
  const keys = new Set<string>();
  const values: readonly unknown[] = value;
  return values.map(item => {
    const identity = decodeBuildScriptIdentity(item);
    bytes += new TextEncoder().encode(JSON.stringify(identity)).length + 1;
    if (bytes > 65_536) invalid();
    const key = `${identity.name}@${identity.version}`;
    if (keys.has(key)) invalid();
    keys.add(key);
    return identity;
  });
}

export interface BuildScriptDecision extends BuildScriptIdentity { readonly decision: "allow" | "deny" }

export function decodeBuildScriptDecisions(value: unknown): readonly BuildScriptDecision[] {
  if (!Array.isArray(value) || value.length > 4096) invalid();
  const values: readonly unknown[] = value;
  const keys = new Set<string>();
  let bytes = 2;
  return values.map(item => {
    const input = record(item, "build-script decision");
    exactKeys(input, ["name", "version", "integrity", "decision"]);
    const identity = decodeBuildScriptIdentity({ name: input["name"], version: input["version"], integrity: input["integrity"] });
    const decision = input["decision"];
    if (decision !== "allow" && decision !== "deny") invalid();
    const key = JSON.stringify([identity.name, identity.version, identity.integrity]);
    if (keys.has(key)) invalid();
    keys.add(key);
    const decoded: BuildScriptDecision = { ...identity, decision };
    bytes += new TextEncoder().encode(JSON.stringify(decoded)).length + 1;
    if (bytes > 65_536) invalid();
    return decoded;
  });
}
