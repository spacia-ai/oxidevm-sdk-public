import { exactKeys, record, string } from "../runtime/decode.js";
import { MODULE_COMMAND_NAME, moduleCommandPath, RESERVED_COMMAND_PREFIX } from "../runtime/module-command-names.js";
import { decodeSHA256 } from "../values.js";
import { isBrowserFeature, isCapability } from "./capabilities.js";
import type { BrowserFeature, Capability } from "./capabilities.js";
import { absolutePath, choice, httpsURL, integerIn, invalid, list, relativePath, text, unique } from "./decode-support.js";
import { classifyLicense } from "./license.js";
import { clashingFileName } from "./served-names.js";
import type {
  ArtifactDecl, EndpointDecl, GuestFileDecl, LicenseDecl, LimitsDecl, MountDecl, OptionDecl, ResolvedArtifact, UpstreamDecl,
} from "./manifest-types.js";

export const MAX_ARTIFACT_BYTES = 512 * 1024 ** 2;
/** A flat file name: it starts with a letter or digit, so neither `.` nor `..` nor a hidden file can be an artifact. */
export const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** Files every release has besides its artifacts; an artifact with one of these names would overwrite it. */
export const RESERVED_RELEASE_FILES: readonly string[] = ["module.json", "adapter.mjs", "SHA256SUMS"];

/** Artifact names must stay distinct files in a staged release (served copies, case-insensitive file systems). */
function distinctArtifacts(names: readonly string[]): void {
  const clash = clashingFileName(names);
  if (clash !== undefined) invalid("artifact names", `${clash} would overwrite another file of the release once served copies are added and case is ignored`);
}

function artifactName(value: unknown): string {
  const name = text(value, "artifact name", ARTIFACT_NAME, 128);
  if (RESERVED_RELEASE_FILES.includes(name)) invalid("artifact name", `${name} is reserved for the release itself`);
  return name;
}
const PROTOCOL = /^[a-z0-9][a-z0-9.+/-]{0,62}$/u;
const OPTION_KEY = /^[a-z][A-Za-z0-9]{0,31}$/u;
const OPTION_VALUE = /^[A-Za-z0-9._-]{1,64}$/u;
const ENDPOINT_KEY = /^[a-z][a-z0-9-]{0,31}$/u;
/** Directories a module may use for sockets and guest files. */
const MODULE_ROOTS = ["/workspace/_oxidevm", "/tmp"] as const;
const DATA_ROOTS = ["/workspace", "/tmp"] as const;

function sorted<T extends string>(items: readonly T[]): T[] {
  return [...items].sort();
}

export function decodeDeclaredArtifacts(value: unknown): readonly ArtifactDecl[] {
  const items = list(value, "artifacts", 64).map((entry, index): ArtifactDecl => {
    const item = record(entry, `artifacts[${String(index)}]`);
    exactKeys(item, ["name", "from"]);
    return { name: artifactName(item["name"]), from: relativePath(item["from"], "artifact from") };
  });
  unique(items.map(item => item.name), "artifact names");
  distinctArtifacts(items.map(item => item.name));
  return items;
}

export function decodeResolvedArtifacts(value: unknown): readonly ResolvedArtifact[] {
  const items = list(value, "artifacts", 64).map((entry, index): ResolvedArtifact => {
    const item = record(entry, `artifacts[${String(index)}]`);
    exactKeys(item, ["name", "sha256", "bytes"]);
    return {
      name: artifactName(item["name"]),
      sha256: decodeSHA256(item["sha256"], "artifact sha256"),
      bytes: integerIn(item["bytes"], "artifact bytes", 0, MAX_ARTIFACT_BYTES),
    };
  });
  unique(items.map(item => item.name), "artifact names");
  distinctArtifacts(items.map(item => item.name));
  return items;
}

export function decodePin(value: unknown, label: string): { readonly sha256: string; readonly bytes: number } {
  const item = record(value, label);
  exactKeys(item, ["sha256", "bytes"]);
  return { sha256: decodeSHA256(item["sha256"], `${label} sha256`), bytes: integerIn(item["bytes"], `${label} bytes`, 0, MAX_ARTIFACT_BYTES) };
}

export function decodeProcess(value: unknown): { readonly kind: "command" } | { readonly kind: "service"; readonly exclusive?: "workspace" } {
  const item = record(value, "process");
  exactKeys(item, ["kind"], ["exclusive"]);
  const kind = choice(item["kind"], "process kind", ["command", "service"]);
  if (kind === "command") {
    if (item["exclusive"] !== undefined) invalid("process", "exclusive applies only to services");
    return { kind };
  }
  return item["exclusive"] === undefined ? { kind } : { kind, exclusive: choice(item["exclusive"], "process exclusive", ["workspace"]) };
}

/** A module's own commands; the name grammar and the stub path belong to the engine's table (engine ADR 0027). */
const MAX_COMMANDS = 16;

function commandName(value: unknown): string {
  const name = string(value, "commands");
  if (!MODULE_COMMAND_NAME.test(name)) return invalid("commands", `${JSON.stringify(name)} is not a command name (lower-case letters, digits, ".", "_", "+" and "-", starting with a letter or digit, at most 64 characters)`);
  if (name.startsWith(RESERVED_COMMAND_PREFIX)) return invalid("commands", `${name} starts with ${RESERVED_COMMAND_PREFIX}, which is reserved`);
  return name;
}

/** A command module's `commands`: a set of one to sixteen names, stored sorted like `requires.host`. */
export function decodeCommands(value: unknown): readonly string[] {
  const names = list(value, "commands", MAX_COMMANDS).map(commandName);
  if (names.length === 0) invalid("commands", "must name at least one command; leave the field out instead");
  unique(names, "commands");
  return sorted(names);
}

/** A module cannot require its own command: that path is the engine's stub, never a program of the image. */
export function rejectOwnCommands(commands: readonly string[], executables: readonly string[]): void {
  const own = commands.find(name => executables.includes(moduleCommandPath(name)));
  if (own !== undefined) invalid("commands", `${own} is this module's own command, so requires.guest.executables cannot list ${moduleCommandPath(own)}`);
}

export function decodeExpose(value: unknown): Readonly<Record<string, EndpointDecl>> {
  const input = record(value, "expose");
  const keys = Object.keys(input).sort();
  if (keys.length === 0 || keys.length > 8) invalid("expose", "must declare one to eight endpoints");
  const output: Record<string, EndpointDecl> = {};
  const paths: string[] = [], ports: string[] = [];
  for (const key of keys) {
    if (!ENDPOINT_KEY.test(key)) invalid("expose", `endpoint name ${JSON.stringify(key)} is invalid`);
    const item = record(input[key], `expose.${key}`);
    const kind = choice(item["kind"], `expose.${key} kind`, ["unix", "tcp"]);
    if (kind === "unix") {
      exactKeys(item, ["kind", "path", "protocol"]);
      const path = absolutePath(item["path"], `expose.${key} path`, { under: MODULE_ROOTS, maxBytes: 107 });
      paths.push(path);
      output[key] = { kind, path, protocol: text(item["protocol"], `expose.${key} protocol`, PROTOCOL, 63) };
    } else {
      exactKeys(item, ["kind", "port", "protocol"]);
      const port = integerIn(item["port"], `expose.${key} port`, 1024, 65535);
      ports.push(String(port));
      output[key] = { kind, port, protocol: text(item["protocol"], `expose.${key} protocol`, PROTOCOL, 63) };
    }
  }
  unique(paths, "expose socket paths");
  unique(ports, "expose ports");
  return output;
}

export function decodeRequires(value: unknown): {
  readonly host: readonly Capability[];
  readonly browser?: readonly BrowserFeature[];
  readonly guest?: { readonly executables?: readonly string[] };
} {
  const item = record(value, "requires");
  exactKeys(item, ["host"], ["browser", "guest"]);
  const host = list(item["host"], "requires.host", 16).map((entry): Capability => {
    if (!isCapability(entry)) return invalid("requires.host", `${JSON.stringify(entry)} is not a known capability`);
    return entry;
  });
  unique(host, "requires.host");
  const result: { host: readonly Capability[]; browser?: readonly BrowserFeature[]; guest?: { readonly executables?: readonly string[] } } = { host: sorted(host) };
  if (item["browser"] !== undefined) {
    const browser = list(item["browser"], "requires.browser", 8).map((entry): BrowserFeature => {
      if (!isBrowserFeature(entry)) return invalid("requires.browser", `${JSON.stringify(entry)} is not a known feature`);
      return entry;
    });
    unique(browser, "requires.browser");
    result.browser = sorted(browser);
  }
  if (item["guest"] !== undefined) {
    const guest = record(item["guest"], "requires.guest");
    exactKeys(guest, [], ["executables"]);
    if (guest["executables"] === undefined) result.guest = {};
    else {
      const executables = list(guest["executables"], "requires.guest.executables", 16).map(entry => absolutePath(entry, "guest executable"));
      unique(executables, "requires.guest.executables");
      result.guest = { executables: sorted(executables) };
    }
  }
  return result;
}

export function decodeMounts(value: unknown): readonly MountDecl[] {
  const mounts = list(value, "mounts", 8).map((entry, index): MountDecl => {
    const item = record(entry, `mounts[${String(index)}]`);
    exactKeys(item, ["guest", "access"], ["durability"]);
    const guest = absolutePath(item["guest"], "mount guest", { under: DATA_ROOTS, self: true });
    const access = choice(item["access"], "mount access", ["ro", "rw"]);
    return item["durability"] === undefined ? { guest, access } : { guest, access, durability: choice(item["durability"], "mount durability", ["fsync"]) };
  });
  unique(mounts.map(mount => mount.guest), "mount paths");
  return mounts;
}

export function decodeLimits(value: unknown): LimitsDecl {
  const item = record(value, "limits");
  exactKeys(item, [], ["clients", "startupMs"]);
  return {
    ...(item["clients"] === undefined ? {} : { clients: integerIn(item["clients"], "limits.clients", 1, 8) }),
    ...(item["startupMs"] === undefined ? {} : { startupMs: integerIn(item["startupMs"], "limits.startupMs", 1000, 600_000) }),
  };
}

export function decodeState(value: unknown): { readonly durable: readonly string[] } {
  const item = record(value, "state");
  exactKeys(item, ["durable"]);
  const durable = list(item["durable"], "state.durable", 16).map(entry => absolutePath(entry, "durable path", { under: ["/workspace"] }));
  unique(durable, "state.durable");
  return { durable: sorted(durable) };
}

export function decodeGuestFiles(value: unknown, artifacts: ReadonlySet<string>): readonly GuestFileDecl[] {
  const files = list(value, "guestFiles", 16).map((entry, index): GuestFileDecl => {
    const item = record(entry, `guestFiles[${String(index)}]`);
    exactKeys(item, ["artifact", "to"], ["mode"]);
    const artifact = artifactName(item["artifact"]);
    if (!artifacts.has(artifact)) invalid("guestFiles", `${artifact} is not a declared artifact`);
    const to = absolutePath(item["to"], "guest file target", { under: DATA_ROOTS });
    return item["mode"] === undefined ? { artifact, to } : { artifact, to, mode: integerIn(item["mode"], "guest file mode", 0, 0o777) };
  });
  unique(files.map(file => file.to), "guest file targets");
  return files;
}

function enumValues(value: unknown, label: string): readonly string[] {
  const values = list(value, label, 64).map(entry => text(entry, label, OPTION_VALUE, 64));
  if (values.length === 0) invalid(label, "must list at least one value");
  unique(values, label);
  return values;
}

function decodeOption(key: string, value: unknown): OptionDecl {
  const label = `options.${key}`;
  const item = record(value, label);
  const type = choice(item["type"], `${label} type`, ["boolean", "integer", "string", "enum", "enum-set"]);
  switch (type) {
    case "boolean": {
      exactKeys(item, ["type"], ["default"]);
      if (item["default"] === undefined) return { type };
      return typeof item["default"] === "boolean" ? { type, default: item["default"] } : invalid(label, "default must be a boolean");
    }
    case "integer": {
      exactKeys(item, ["type", "min", "max"], ["default"]);
      const min = integerIn(item["min"], `${label} min`, -(2 ** 31), 2 ** 31), max = integerIn(item["max"], `${label} max`, min, 2 ** 31);
      return item["default"] === undefined ? { type, min, max } : { type, min, max, default: integerIn(item["default"], `${label} default`, min, max) };
    }
    case "string": {
      exactKeys(item, ["type", "maxLength"], ["default"]);
      const maxLength = integerIn(item["maxLength"], `${label} maxLength`, 1, 4096);
      if (item["default"] === undefined) return { type, maxLength };
      const fallback = string(item["default"], `${label} default`);
      return fallback.length <= maxLength ? { type, maxLength, default: fallback } : invalid(label, "default exceeds maxLength");
    }
    case "enum": {
      exactKeys(item, ["type", "values"], ["default"]);
      const values = enumValues(item["values"], `${label} values`);
      if (item["default"] === undefined) return { type, values };
      const fallback = choice(item["default"], `${label} default`, values);
      return { type, values, default: fallback };
    }
    case "enum-set": {
      exactKeys(item, ["type", "values"], ["default"]);
      const values = enumValues(item["values"], `${label} values`);
      if (item["default"] === undefined) return { type, values };
      const fallback = list(item["default"], `${label} default`, 64).map(entry => choice(entry, `${label} default`, values));
      unique(fallback, `${label} default`);
      return { type, values, default: fallback };
    }
  }
}

export function decodeOptions(value: unknown): Readonly<Record<string, OptionDecl>> {
  const input = record(value, "options");
  const keys = Object.keys(input).sort();
  if (keys.length > 16) invalid("options", "declares more than sixteen options");
  const output: Record<string, OptionDecl> = {};
  for (const key of keys) {
    if (!OPTION_KEY.test(key)) invalid("options", `option name ${JSON.stringify(key)} is invalid`);
    output[key] = decodeOption(key, input[key]);
  }
  return output;
}

export function decodeLicense(value: unknown, artifacts: ReadonlySet<string>): LicenseDecl {
  const item = record(value, "license");
  exactKeys(item, ["spdx"], ["notices", "source"]);
  const spdx = text(item["spdx"], "license.spdx", /^[^\n\r]+$/u, 256);
  classifyLicense(spdx);
  // A notice is an artifact, so it is pinned, cached and staged like any other file of the release.
  const notices = item["notices"] === undefined ? undefined : list(item["notices"], "license.notices", 16).map(entry => {
    const name = artifactName(entry);
    if (!artifacts.has(name)) invalid("license.notices", `${name} is not a declared artifact`);
    return name;
  });
  if (notices !== undefined) unique(notices, "license.notices");
  return {
    spdx,
    ...(notices === undefined ? {} : { notices }),
    ...(item["source"] === undefined ? {} : { source: httpsURL(item["source"], "license.source") }),
  };
}

export function decodeUpstream(value: unknown): readonly UpstreamDecl[] {
  return list(value, "upstream", 16).map((entry, index): UpstreamDecl => {
    const item = record(entry, `upstream[${String(index)}]`);
    exactKeys(item, ["name", "version", "source"]);
    return {
      name: text(item["name"], "upstream name", /^[^\n\r]+$/u, 128),
      version: text(item["version"], "upstream version", /^[^\n\r\s]+$/u, 64),
      source: httpsURL(item["source"], "upstream source"),
    };
  });
}
