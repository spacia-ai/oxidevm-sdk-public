import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeSHA256 } from "../values.js";
import { hash } from "./files.js";

export interface ImageSourcePin { readonly identifier: string; readonly pinnedIdentifier: string }
export interface BuildkitInputFacts {
  readonly kind: "dockerfile"; readonly platform: "linux/amd64";
  readonly dockerfileSHA256: string; readonly contextSHA256: string; readonly buildArgsSHA256: string;
  readonly target: string | null; readonly images: readonly ImageSourcePin[];
  readonly tools: { readonly docker: string; readonly buildx: string; readonly buildkit: readonly string[] };
}
function invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", `BuildKit inputs: ${message}`); }
function text(value: unknown, label: string, maximum = 8192): string {
  const output = string(value, label); if (output.length < 1 || output.length > maximum || output.includes("\0")) return invalid(`${label} exceeds its bound`); return output;
}
function array(value: unknown, label: string, maximum = 4096): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(`${label} exceeds its list bound`); return Array.from<unknown>(value);
}
function dockerIdentifier(value: unknown): string {
  const output = text(value, "image identifier");
  if (!/^docker-image:\/\/[A-Za-z0-9._:/+-]+(?:@sha256:[0-9a-f]{64})?$/u.test(output)) return invalid("image identifier contains unsupported reference syntax");
  return output;
}
function repository(value: string): string { return value.replace(/^docker\.io\/(?:library\/)?/u, "").replace(/^library\//u, ""); }
function materialComponent(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return invalid("material URI contains malformed encoding"); }
}

/** Candidate reproduction cannot depend on an unrecorded RUN network or remote source. */
export function validateDistributionBuildkit(value: unknown): void {
  const provenance = record(value, "BuildKit provenance");
  if (provenance["buildType"] !== "https://mobyproject.org/buildkit@v1") return invalid("a real BuildKit provenance statement is required");
  const build = record(provenance["buildConfig"], "LLB build configuration");
  for (const value of array(build["llbDefinition"], "LLB definition")) {
    const op = record(record(record(value, "LLB step")["op"], "LLB operation")["Op"], "LLB operation variant");
    if (op["exec"] !== undefined && record(op["exec"], "LLB execution")["network"] !== 2) return invalid("distribution RUN steps must use an offline network");
    if (op["source"] !== undefined) {
      const identifier = text(record(op["source"], "LLB source")["identifier"], "source identifier");
      if (identifier.startsWith("docker-image://")) dockerIdentifier(identifier);
      else if (identifier !== "local://context" && identifier !== "local://dockerfile") return invalid("distribution source must be a locked image or the inventoried local context; vendor remote inputs before building");
    }
  }
}

/** Resolve pins from the actual BuildKit solve, without parsing or interpreting Dockerfile syntax. */
export function resolvedBuildkitImages(value: unknown): readonly ImageSourcePin[] {
  const provenance = record(value, "BuildKit provenance");
  if (provenance["buildType"] !== "https://mobyproject.org/buildkit@v1") return invalid("a real BuildKit provenance statement is required");
  const materials = array(provenance["materials"], "materials").map(item => record(item, "material"));
  const build = record(provenance["buildConfig"], "LLB build configuration");
  const images = new Set<string>();
  for (const value of array(build["llbDefinition"], "LLB definition")) {
    const step = record(value, "LLB step"); const op = record(record(step["op"], "LLB operation")["Op"], "LLB operation variant");
    if (op["source"] === undefined) continue;
    const identifier = text(record(op["source"], "LLB source")["identifier"], "source identifier");
    if (identifier.startsWith("docker-image://")) images.add(dockerIdentifier(identifier));
  }
  return [...images].sort().map(identifier => {
    if (/@sha256:[0-9a-f]{64}$/u.test(identifier)) return { identifier, pinnedIdentifier: identifier };
    const reference = identifier.slice("docker-image://".length); const colon = reference.lastIndexOf(":");
    const hasTag = colon > reference.lastIndexOf("/"); const name = repository(hasTag ? reference.slice(0, colon) : reference); const tag = hasTag ? reference.slice(colon + 1) : "latest";
    const matching = materials.filter(material => {
      const uri = text(material["uri"], "material URI"); const raw = uri.split("?", 1)[0];
      if (raw === undefined || !raw.startsWith("pkg:docker/")) return false;
      const at = raw.lastIndexOf("@");
      return at >= 0 && repository(materialComponent(raw.slice(11, at))) === name && materialComponent(raw.slice(at + 1)) === tag;
    });
    const material = matching[0]; if (matching.length !== 1 || material === undefined) return invalid("an unpinned image has no unique resolved material");
    const digest = decodeSHA256(record(material["digest"], "material digest")["sha256"], "resolved image digest");
    return { identifier, pinnedIdentifier: `${identifier}@sha256:${digest}` };
  });
}

export function decodeBuildkitInputFacts(value: unknown): BuildkitInputFacts {
  const input = record(value, "locked Dockerfile inputs");
  exactKeys(input, ["kind", "platform", "dockerfileSHA256", "contextSHA256", "buildArgsSHA256", "target", "images", "tools"]);
  if (input["kind"] !== "dockerfile" || input["platform"] !== "linux/amd64") return invalid("invalid Dockerfile lock kind/platform");
  const tools = record(input["tools"], "build tool identities"); exactKeys(tools, ["docker", "buildx", "buildkit"]);
  return { kind: "dockerfile", platform: "linux/amd64", dockerfileSHA256: decodeSHA256(input["dockerfileSHA256"], "Dockerfile pin"), contextSHA256: decodeSHA256(input["contextSHA256"], "context pin"), buildArgsSHA256: decodeSHA256(input["buildArgsSHA256"], "argument pin"),
    target: input["target"] === null ? null : text(input["target"], "target"),
    images: array(input["images"], "image pins").map(value => { const pin = record(value, "image pin"); exactKeys(pin, ["identifier", "pinnedIdentifier"]);
      const identifier = dockerIdentifier(pin["identifier"]); const pinnedIdentifier = dockerIdentifier(pin["pinnedIdentifier"]);
      if (!/@sha256:[0-9a-f]{64}$/u.test(pinnedIdentifier) || pinnedIdentifier.replace(/@sha256:[0-9a-f]{64}$/u, "") !== identifier.replace(/@sha256:[0-9a-f]{64}$/u, "")) return invalid("source policy pin changes the image repository or tag");
      return { identifier, pinnedIdentifier }; }),
    tools: { docker: text(tools["docker"], "Docker version", 256), buildx: text(tools["buildx"], "Buildx version", 256), buildkit: array(tools["buildkit"], "BuildKit versions", 16).map(value => text(value, "BuildKit version", 256)) } };
}
export function sourcePolicy(images: readonly ImageSourcePin[]): string {
  return JSON.stringify({ rules: images.map(image => ({ action: "CONVERT", selector: { identifier: image.identifier }, updates: { identifier: image.pinnedIdentifier } })) });
}
export function buildArgumentsIdentity(arguments_: Readonly<Record<string, string>>): string {
  return hash(JSON.stringify(Object.entries(arguments_).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}
