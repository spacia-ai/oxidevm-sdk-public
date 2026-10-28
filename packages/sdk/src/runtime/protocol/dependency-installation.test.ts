import { expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./common.js";
import { decodeInstallationCommand, installationResponseDecoders } from "./dependency-installation.js";

it("validates installation operations, exact fields and terminal identities", () => {
  const command = { id: 1, version: PROTOCOL_VERSION, type: "kill", signal: "INT" };
  expect(decodeInstallationCommand(command)).toEqual({ id: 1, type: "kill", signal: "INT" });
  for (const patch of [{ id: 0 }, { version: PROTOCOL_VERSION - 1 }, { signal: "USR1" }, { port: 1 }, { type: "spawn" }]) {
    expect(() => decodeInstallationCommand({ ...command, ...patch })).toThrow();
  }
  expect(installationResponseDecoders.exit({ code: 37 })).toEqual({ code: 37 });
  expect(installationResponseDecoders.exit({ code: null, signal: "SIGTERM" })).toEqual({ code: null, signal: "SIGTERM" });
  for (const exit of [{ code: null }, { code: 0, signal: "SIGKILL" }, { code: 256 }, { code: null, signal: "arbitrary" }]) {
    expect(() => installationResponseDecoders.exit(exit)).toThrow();
  }
  expect(installationResponseDecoders.generation("a".repeat(64))).toBe("a".repeat(64));
  for (const digest of ["a".repeat(63), "A".repeat(64), null]) expect(() => installationResponseDecoders.generation(digest)).toThrow();
  expect(() => installationResponseDecoders.stdio({ stdin: {}, stdout: {}, stderr: {} })).toThrow();
  const stdin = new WritableStream();
  const stdout = new ReadableStream({ start: controller => controller.close() });
  const stderr = new ReadableStream({ start: controller => controller.close() });
  expect(() => installationResponseDecoders.stdio({ stdin, stdout, stderr: stdout })).toThrow();
  const writer = stdin.getWriter();
  expect(() => installationResponseDecoders.stdio({ stdin, stdout, stderr })).toThrow();
  writer.releaseLock();
});
