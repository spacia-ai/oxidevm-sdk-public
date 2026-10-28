import { exactKeys, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { protocol } from "../../js-process/codec.js";
import type { createNodePorts } from "./message-port.js";

type Ports = Pick<ReturnType<typeof createNodePorts>, "clone" | "receive">;

/** Application errors retain their native class and own properties, separately from transport failures. */
export function encodeWorkerException(error: unknown, ports: Ports): unknown {
  const names = error instanceof Error ? Object.getOwnPropertyNames(error) : [];
  if (names.length > 4096 || names.some(name => name.length > 1024)) throw new VMError("QUOTA_EXCEEDED", "Worker exception exceeds its property limit");
  const properties = names.map(name => {
    if (!(error instanceof Error)) protocol("Invalid worker error properties");
    const property = Object.getOwnPropertyDescriptor(error, name);
    const value: unknown = Reflect.get(error, name);
    return [name, property?.enumerable === true, value];
  });
  return ports.clone({ version: 1, error, properties }).value;
}

export function decodeWorkerException(input: unknown, ports: Ports): unknown {
  const value = record(ports.receive(input), "worker exception"); exactKeys(value, ["version", "error", "properties"]);
  if (value["version"] !== 1) protocol("Worker exception version mismatch");
  const error = value["error"], properties = value["properties"], names = new Set<string>();
  if (!Array.isArray(properties) || properties.length > 4096 || (!(error instanceof Error) && properties.length !== 0)) protocol("Invalid worker exception properties");
  for (const entry of properties) {
    if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== "string" || entry[0].length > 1024 || typeof entry[1] !== "boolean" || names.has(entry[0])) protocol("Invalid worker exception property");
    names.add(entry[0]);
    if (error instanceof Error) Object.defineProperty(error, entry[0], { value: entry[2], enumerable: entry[1], writable: true, configurable: true });
  }
  return error;
}
