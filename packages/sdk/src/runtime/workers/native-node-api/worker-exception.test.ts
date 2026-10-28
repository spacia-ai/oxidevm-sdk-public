import { expect, it } from "vitest";
import { createAsyncContext } from "../assistance/async-context.js";
import { createNodePorts } from "./message-port.js";
import { decodeWorkerException, encodeWorkerException } from "./worker-exception.js";

it("preserves the native error class, stack, custom properties and cyclic identity across workers", () => {
  const ports = createNodePorts(createAsyncContext(), callback => callback(), () => {});
  const error = Object.assign(new TypeError("worker failed"), { code: "CUSTOM", extra: 42 }); Object.defineProperty(error, "self", { value: error, enumerable: true });
  Object.defineProperty(error, "__proto__", { value: "ordinary property", enumerable: true });
  const decoded = decodeWorkerException(encodeWorkerException(error, ports), ports);
  expect(decoded).toBeInstanceOf(TypeError); expect(decoded).not.toBe(error);
  expect(decoded).toMatchObject({ message: error.message, stack: error.stack, code: "CUSTOM", extra: 42 });
  if (!(decoded instanceof Error)) throw new Error("Missing error");
  expect(Reflect.get(decoded, "self")).toBe(decoded);
  expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe("ordinary property");
  expect(decodeWorkerException(encodeWorkerException("thrown value", ports), ports)).toBe("thrown value");
  expect(() => decodeWorkerException(ports.clone({ version: 2, error: null, properties: [] }).value, ports)).toThrow(/version/u);
  ports.dispose();
});
