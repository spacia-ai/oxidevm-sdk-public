import { exactKeys, record } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";
import { validateSpawnSpec } from "./runtime/vm-options.js";
import { isTrustworthyURL } from "./trustworthy-url.js";

export function validateJSProcessSpec(input: unknown) {
  const spec = record(input, "JS process spec"); exactKeys(spec, ["worker"], ["args", "cwd", "env", "terminal", "signal"]);
  if (!(spec["worker"] instanceof URL)) throw new VMError("INVALID_ARGUMENT", "JS process worker must be a URL");
  const worker = spec["worker"];
  if (!isTrustworthyURL(worker) || worker.origin !== location.origin || !globalThis.crossOriginIsolated) throw new VMError("FEATURE_NOT_AVAILABLE", "JS processes require a same-origin trusted worker and cross-origin isolation");
  const decoded = validateSpawnSpec({ command: "/js-process", args: spec["args"] ?? [], cwd: spec["cwd"] ?? "/workspace", env: spec["env"] ?? {}, ...(spec["signal"] === undefined ? {} : { signal: spec["signal"] }), ...(spec["terminal"] === undefined ? {} : { terminal: spec["terminal"] }) }, true);
  return { ...decoded, worker: worker.href };
}
