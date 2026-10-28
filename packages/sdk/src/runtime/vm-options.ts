import { decodeCommandInterceptors } from "../command-interceptors.js";
import { VMError } from "./errors.js";
import { boolean, exactKeys, integer, record, string } from "./decode.js";
import { normalizeWorkspacePath, validateWorkspaceId } from "./workspace-path.js";
import type { AssistanceOptions, CommonOptions, RuntimeVMOptions, DependencyPreparationOptions, UserspaceLimitsOptions, PreviewIsolation, ProcessExecution, SpawnSpec } from "./vm-types.js";

export function validateDependencyPreparation(value: unknown): Required<Pick<DependencyPreparationOptions, "cwd" | "frozenLockfile">> & Pick<DependencyPreparationOptions, "signal"> {
  try {
    const options = record(value === undefined ? {} : value, "dependency preparation");
    exactKeys(options, [], ["cwd", "frozenLockfile", "signal"]);
    const cwd = string(options["cwd"] === undefined ? "/" : options["cwd"], "cwd");
    const frozenLockfile = boolean(options["frozenLockfile"] === undefined ? true : options["frozenLockfile"], "frozenLockfile");
    const signal = options["signal"];
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new VMError("INVALID_ARGUMENT", "signal must be an AbortSignal");
    return { cwd: `/${normalizeWorkspacePath(cwd).join("/")}`, frozenLockfile, ...(signal === undefined ? {} : { signal }) };
  } catch (error) {
    if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message);
    throw error;
  }
}

export function validateSpawnSpec(value: unknown, guestPaths = false): Required<
  Pick<SpawnSpec, "command" | "args" | "cwd" | "env">
> & { readonly execution?: ProcessExecution; readonly signal?: AbortSignal; readonly terminal?: { readonly columns: number; readonly rows: number } } {
  const spec = record(value, "spawn spec");
  exactKeys(spec, ["command"], ["args", "cwd", "env", "terminal", "signal", "execution"]);
  const command = string(spec["command"], "command");
  if (command.length === 0 || command.includes("\0")) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "command must be non-empty and contain no NUL",
    );
  }
  const rawArgs = spec["args"] ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.length > 4096) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "args must be an array with at most 4096 entries",
    );
  }
  const args = rawArgs.map((value, index) => {
    const argument = string(value, `args[${index}]`);
    if (argument.includes("\0")) {
      throw new VMError("INVALID_ARGUMENT", `args[${index}] contains NUL`);
    }
    return argument;
  });
  const rawCwd = spec["cwd"] ?? "/";
  const rawPath = string(rawCwd, "cwd");
  if (guestPaths && (!rawPath.startsWith("/") || rawPath.includes("\0") || rawPath.length > 4096)) throw new VMError("INVALID_ARGUMENT", "guest cwd must be a bounded absolute path");
  const cwd = guestPaths ? rawPath : `/${normalizeWorkspacePath(rawPath).join("/")}`;
  const rawEnvironment = spec["env"] ?? {};
  const environment = record(rawEnvironment, "env");
  if (Object.keys(environment).length > 4096) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "env may contain at most 4096 entries",
    );
  }
  const env = Object.fromEntries(
    Object.entries(environment).map(([key, entry]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new VMError(
          "INVALID_ARGUMENT",
          `invalid environment key ${key}`,
        );
      }
      const environmentValue = string(entry, `env.${key}`);
      if (environmentValue.includes("\0")) {
        throw new VMError(
          "INVALID_ARGUMENT",
          `environment value ${key} contains NUL`,
        );
      }
      return [key, environmentValue];
    }),
  );
  const signal = spec["signal"];
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new VMError("INVALID_ARGUMENT", "signal must be an AbortSignal");
  }
  const terminalValue = spec["terminal"];
  let terminal: { readonly columns: number; readonly rows: number } | undefined;
  if (terminalValue !== undefined) {
    const decoded = record(terminalValue, "terminal");
    exactKeys(decoded, ["columns", "rows"]);
    terminal = {
      columns: integer(decoded["columns"], "terminal.columns", 1, 1_000),
      rows: integer(decoded["rows"], "terminal.rows", 1, 1_000),
    };
  }
  const execution = decodeExecution(spec["execution"]);
  if (execution?.kind === "assisted-node" && (command !== "node" || args.length === 0 || args[0]?.startsWith("-") === true || args[0] === "" || terminal !== undefined)) {
    throw new VMError("INVALID_ARGUMENT", "Assistance requires node <local-script> [arguments] without Node flags or a PTY");
  }
  return {
    command,
    args,
    cwd,
    env: guestPaths ? { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/workspace", ...env } : env,
    ...(execution === undefined ? {} : { execution }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(signal === undefined ? {} : { signal }),
  };
}

export function validateRuntimeVMOptions(
  value: unknown,
): RuntimeVMOptions {
  try {
    return decodeRuntimeVMOptions(value);
  } catch (error) {
    if (error instanceof VMError && error.code === "PROTOCOL_ERROR") {
      throw new VMError("INVALID_ARGUMENT", error.message);
    }
    throw error;
  }
}

function decodeRuntimeVMOptions(value: unknown): RuntimeVMOptions {
  const options = record(value, "options");
  const mode = string(options["mode"], "mode");
  const network = string(options["network"], "network");
  if (mode !== "system" && mode !== "userspace") {
    throw new VMError("INVALID_ARGUMENT", "mode must be 'system' or 'userspace'");
  }
  if (network !== "local" && network !== "relay") {
    throw new VMError(
      "INVALID_ARGUMENT",
      "network must be 'local' or 'relay'",
    );
  }
  const workspaceId = validateWorkspaceId(
    string(options["workspaceId"], "workspaceId"),
  );
  const memoryMiB = integer(options["memoryMiB"], "memoryMiB", 64, 3072);
  const relayPolicy = options["relayPolicy"];
  if (relayPolicy !== undefined && relayPolicy !== "personal-only") throw new VMError("INVALID_ARGUMENT", "Invalid relay policy");
  const relayUrl = optionalString(options["relayUrl"], "relayUrl");
  const previewOrigin = decodePreviewOrigin(options["previewOrigin"]);
  const previewIsolation = decodePreviewIsolation(options["previewIsolation"], previewOrigin);
  if (network === "relay" && relayUrl === undefined) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "relayUrl is required when network is 'relay'",
    );
  }
  if (relayUrl !== undefined) {
    let relay: URL;
    try {
      relay = new URL(relayUrl);
    } catch {
      throw new VMError("INVALID_ARGUMENT", "relayUrl must be a valid URL");
    }
    const localHttp = relay.protocol === "http:" && (relay.hostname === "127.0.0.1" || relay.hostname === "localhost");
    if (relay.protocol !== "https:" && !localHttp) {
      throw new VMError("INVALID_ARGUMENT", "relayUrl must use HTTPS");
    }
  }

  const common = {
    ...(options["ephemeral"] === undefined ? {} : { ephemeral: boolean(options["ephemeral"], "ephemeral workspace") }),
    workspaceId,
    memoryMiB,
    network,
    ...(relayPolicy === undefined ? {} : { relayPolicy }),
    ...(relayUrl === undefined ? {} : { relayUrl }),
    ...(previewOrigin === undefined ? {} : { previewOrigin }),
    ...(previewIsolation === undefined ? {} : { previewIsolation }),
  } satisfies CommonOptions;
  if (mode === "system") {
    exactKeys(
      options,
      ["mode", "workspaceId", "memoryMiB", "network", "vcpus"],
      ["relayUrl", "relayPolicy", "previewOrigin", "previewIsolation", "coreWasmUrl", "sharedCoreWasmUrl", "netstackWasmUrl", "assistance", "ephemeral"],
    );
    const coreWasmUrl = optionalString(options["coreWasmUrl"], "coreWasmUrl");
    const sharedCoreWasmUrl = optionalString(options["sharedCoreWasmUrl"], "sharedCoreWasmUrl");
    const netstackWasmUrl = optionalString(options["netstackWasmUrl"], "netstackWasmUrl");
    const assistance = decodeAssistance(options["assistance"], previewOrigin);
    return {
      ...common,
      mode,
      vcpus: decodeVcpus(options["vcpus"]),
      ...(assistance === undefined ? {} : { assistance }),
      ...(coreWasmUrl === undefined ? {} : { coreWasmUrl }),
      ...(sharedCoreWasmUrl === undefined ? {} : { sharedCoreWasmUrl }),
      ...(netstackWasmUrl === undefined ? {} : { netstackWasmUrl }),
    };
  }
  exactKeys(
    options,
    ["mode", "workspaceId", "memoryMiB", "network"],
    ["relayUrl", "relayPolicy", "previewOrigin", "previewIsolation", "userspaceWasmUrl", "userspaceSharedWasmUrl", "limits", "ephemeral", "initialUser", "rootPersistence", "interceptors", "nativeExecutionPort"],
  );
  const userspaceWasmUrl = optionalString(options["userspaceWasmUrl"], "userspaceWasmUrl");
  const userspaceSharedWasmUrl = optionalString(
    options["userspaceSharedWasmUrl"],
    "userspaceSharedWasmUrl",
  );
  const limits = decodeUserspaceLimits(options["limits"]);
  const nativeExecutionPort = options["nativeExecutionPort"];
  if (nativeExecutionPort !== undefined && !(nativeExecutionPort instanceof MessagePort)) throw new VMError("INVALID_ARGUMENT", "Native execution port must be a MessagePort");
  const initialUser = options["initialUser"];
  const rootPersistence = options["rootPersistence"];
  if (initialUser !== undefined && initialUser !== "user" && initialUser !== "root") {
    throw new VMError("INVALID_ARGUMENT", "initialUser must be 'user' or 'root'");
  }
  if (rootPersistence !== undefined && rootPersistence !== "ephemeral" && rootPersistence !== "persistent") {
    throw new VMError("INVALID_ARGUMENT", "rootPersistence must be 'ephemeral' or 'persistent'");
  }
  if (rootPersistence === "persistent" && options["ephemeral"] === true) {
    throw new VMError("INVALID_ARGUMENT", "Persistent root storage requires a durable workspace");
  }
  return {
    ...common,
    mode,
    ...(userspaceWasmUrl === undefined ? {} : { userspaceWasmUrl }),
    ...(userspaceSharedWasmUrl === undefined ? {} : { userspaceSharedWasmUrl }),
    ...(limits === undefined ? {} : { limits }),
    ...(nativeExecutionPort === undefined ? {} : { nativeExecutionPort }),
    ...(options["interceptors"] === undefined ? {} : { interceptors: decodeCommandInterceptors(options["interceptors"]) }),
    ...(initialUser === undefined ? {} : { initialUser }),
    ...(rootPersistence === undefined ? {} : { rootPersistence }),
  };
}

function decodeExecution(value: unknown): ProcessExecution | undefined {
  if (value === undefined) return undefined;
  const execution = record(value, "execution");
  if (execution["kind"] === "guest") {
    exactKeys(execution, ["kind"]);
    return { kind: "guest" };
  }
  exactKeys(execution, ["kind", "profile"]);
  if (execution["kind"] !== "assisted-node" || execution["profile"] !== "node24-next16-v1") {
    throw new VMError("INVALID_ARGUMENT", "Unsupported execution backend or assistance profile");
  }
  return { kind: "assisted-node", profile: "node24-next16-v1" };
}

function decodeAssistance(value: unknown, previewOrigin: string | undefined): AssistanceOptions | undefined {
  if (value === undefined) return undefined;
  const options = record(value, "assistance");
  exactKeys(options, ["executionOrigin", "manifestUrl"], ["approveBuildScript"]);
  const callback = options["approveBuildScript"];
  if (callback !== undefined && typeof callback !== "function") throw new VMError("INVALID_ARGUMENT", "approveBuildScript must be a function");
  let origin: URL;
  let manifest: URL;
  try {
    origin = new URL(string(options["executionOrigin"], "executionOrigin"));
    manifest = new URL(string(options["manifestUrl"], "manifestUrl"));
  } catch {
    throw new VMError("INVALID_ARGUMENT", "Assistance requires absolute HTTPS URLs");
  }
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" ||
      origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
      manifest.origin !== origin.origin || manifest.username !== "" || manifest.password !== "" || manifest.hash !== "" ||
      origin.origin === previewOrigin || (typeof globalThis.location === "object" && origin.origin === globalThis.location.origin)) {
    throw new VMError("INVALID_ARGUMENT", "Assistance requires a separate HTTPS execution origin and a manifest on that origin");
  }
  return { executionOrigin: origin.origin, manifestUrl: manifest.href,
    ...(callback === undefined ? {} : { approveBuildScript: async (request) => {
      requireActiveApproval(request.signal);
      const completion = Promise.withResolvers<unknown>();
      const abort = () => completion.reject(new VMError("ABORTED", "Build script approval cancelled"));
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        try {
          const response: unknown = Reflect.apply(callback, undefined, [request]);
          void Promise.resolve(response).then(completion.resolve, completion.reject);
        } catch (error) { completion.reject(error); }
        const result = await completion.promise;
        requireActiveApproval(request.signal);
        if (result !== "allow" && result !== "deny") throw new VMError("INVALID_ARGUMENT", "Build script approval must return allow or deny");
        return result;
      } finally { request.signal.removeEventListener("abort", abort); }
    } }),
  };
}

function requireActiveApproval(signal: AbortSignal): void {
  if (signal.aborted) throw new VMError("ABORTED", "Build script approval cancelled");
}

function decodePreviewOrigin(value: unknown): string | undefined {
  const source = optionalString(value, "previewOrigin");
  if (source === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new VMError("INVALID_ARGUMENT", "previewOrigin must be a valid URL origin");
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !localHttp) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new VMError("INVALID_ARGUMENT", "previewOrigin must be an isolated HTTPS origin");
  }
  if (typeof globalThis.location === "object" && url.origin === globalThis.location.origin) {
    throw new VMError("INVALID_ARGUMENT", "previewOrigin must differ from the IDE origin");
  }
  return url.origin;
}

function decodePreviewIsolation(value: unknown, previewOrigin: string | undefined): PreviewIsolation | undefined {
  if (value === undefined) return undefined;
  if (value !== "per-session" && value !== "shared") {
    throw new VMError("INVALID_ARGUMENT", "previewIsolation must be 'per-session' or 'shared'");
  }
  if (previewOrigin === undefined) throw new VMError("INVALID_ARGUMENT", "previewIsolation requires previewOrigin");
  return value;
}

function decodeUserspaceLimits(value: unknown): UserspaceLimitsOptions | undefined {
  if (value === undefined) return undefined;
  const limits = record(value, "Userspace limits");
  exactKeys(limits, [], ["maxProcesses"]);
  return limits["maxProcesses"] === undefined
    ? {}
    : { maxProcesses: integer(limits["maxProcesses"], "maxProcesses", 1, 64) };
}

function decodeVcpus(value: unknown): 1 | 2 | 3 | 4 {
  const vcpus = integer(value, "vcpus", 1, 4);
  switch (vcpus) {
    case 1:
    case 2:
    case 3:
    case 4:
      return vcpus;
    default:
      throw new VMError("INVALID_ARGUMENT", "vcpus must be from 1 to 4");
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}
