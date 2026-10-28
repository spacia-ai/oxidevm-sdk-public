import { exactKeys, record, string } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";
import type { ImageSmokeTest } from "./image-builder/contracts.js";

export function decodeImageSmokeTest(value: unknown): ImageSmokeTest {
  const input = record(value, "smoke test"); exactKeys(input, ["command", "expectedExitCode"], ["args", "cwd", "stdoutIncludes"]);
  const bounded = (value: unknown): string => {
    const result = string(value, "smoke argument");
    if (result.length > 8192 || result.includes("\0")) throw new VMError("INVALID_ARGUMENT", "smoke arguments must be bounded and contain no NUL");
    return result;
  };
  const command = bounded(input["command"]);
  if (command.length === 0 || input["expectedExitCode"] !== 0) throw new VMError("INVALID_ARGUMENT", "smoke test requires a command and exit code zero");
  const args: string[] = [];
  if (input["args"] !== undefined) {
    if (!Array.isArray(input["args"]) || input["args"].length > 1024) throw new VMError("INVALID_ARGUMENT", "smoke arguments must be a bounded array");
    for (const value of Array.from<unknown>(input["args"])) args.push(bounded(value));
  }
  return { command, expectedExitCode: 0, ...(input["args"] === undefined ? {} : { args }), ...(input["cwd"] === undefined ? {} : { cwd: bounded(input["cwd"]) }), ...(input["stdoutIncludes"] === undefined ? {} : { stdoutIncludes: bounded(input["stdoutIncludes"]) }) };
}
