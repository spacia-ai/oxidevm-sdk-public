import { expect, it } from "vitest";
import { decodePublicVMOptions } from "../../vm-options.js";
import { decodeFrameOptions, encodeFrameOptions } from "./options.js";

it("carries explicit Userspace credentials and root persistence across the validated frame boundary", () => {
  const options = decodePublicVMOptions({ mode: "userspace", commandInterceptors: "off", workspaceId: "example", initialUser: "root", rootPersistence: "persistent" });
  const wire = encodeFrameOptions(options, "https://page.test/");
  expect(decodeFrameOptions(wire, "/engine/")).toMatchObject({ mode: "userspace", initialUser: "root", rootPersistence: "persistent" });
  expect(encodeFrameOptions(decodePublicVMOptions({ mode: "userspace" }), "https://page.test/")).not.toHaveProperty("initialUser");
  expect(() => decodeFrameOptions({ ...wire, mode: "system" }, "/engine/")).toThrow();
  expect(() => decodeFrameOptions({ ...wire, initialUser: "admin" }, "/engine/")).toThrow();
  const { workspaceId: omitted, ...ephemeral } = wire;
  expect(omitted).toBe("example");
  expect(() => decodeFrameOptions(ephemeral, "/engine/")).toThrow("workspaceId");
});

it("preserves the built-in interceptor opt-out through the runtime frame", () => {
  const options = decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame" }, commandInterceptors: "off" });
  const wire = encodeFrameOptions(options, "https://page.test/");
  expect(wire).toHaveProperty("commandInterceptors", "off");
  expect(decodeFrameOptions(wire, "/engine/")).toMatchObject({ acceleration: "off", interceptors: false });
  expect(() => decodeFrameOptions({ ...wire, commandInterceptors: [{ command: "tsc", worker: "https://page.test/custom.js" }] }, "/engine/")).toThrow();
});

it("keeps custom worker URLs out of the runtime frame", () => {
  const options = { mode: "userspace", network: { mode: "local" }, workspaceId: "frame", commandInterceptors: [{ command: "tsc", worker: "https://page.test/worker.js" }] };
  expect(() => decodeFrameOptions(options, "/engine/")).toThrow("built-in");
});

it("preserves automatic acceleration and explicit opt-out across the runtime frame", () => {
  for (const commandInterceptors of [undefined, "auto", "off"] as const) {
    const options = decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame" }, ...(commandInterceptors === undefined ? {} : { commandInterceptors }) });
    const wire = encodeFrameOptions(options, "https://page.test/");
    expect(wire).toHaveProperty("commandInterceptors", commandInterceptors ?? "auto");
    expect(decodeFrameOptions(wire, "/engine/")).toHaveProperty("acceleration", commandInterceptors === "off" ? "off" : "auto");
    expect(() => decodeFrameOptions({ ...wire, commandInterceptors: "fast" }, "/engine/")).toThrow();
    expect(() => decodeFrameOptions({ ...wire, mode: "system" }, "/engine/")).toThrow();
  }
});

it("lets only the frame decide whether a workspace is in use", () => {
  const temporary = encodeFrameOptions(decodePublicVMOptions({ mode: "userspace", workspaceId: "notes", workspaceInUse: "temporary", runtime: { hosting: "frame" } }), "https://page.test/");
  expect(temporary).toMatchObject({ workspaceId: "notes", workspaceInUse: "temporary" });
  // The page never picks the temporary workspace itself: it cannot see the frame's locks.
  expect(decodeFrameOptions(temporary, "/engine/")).toMatchObject({ workspaceId: "notes", ephemeral: false, workspaceInUse: "temporary" });
  const durable = encodeFrameOptions(decodePublicVMOptions({ mode: "system", workspaceId: "notes", runtime: { hosting: "frame" } }), "https://page.test/");
  expect(durable).not.toHaveProperty("workspaceInUse");
  expect(decodeFrameOptions(durable, "/engine/")).toMatchObject({ workspaceInUse: "fail" });
  expect(encodeFrameOptions(decodePublicVMOptions({ mode: "userspace", runtime: { hosting: "frame" } }), "https://page.test/")).not.toHaveProperty("workspaceInUse");
  expect(() => decodeFrameOptions({ ...temporary, workspaceInUse: "share" }, "/engine/")).toThrow();
  const { workspaceId: omitted, ...withoutWorkspace } = temporary;
  expect(omitted).toBe("notes");
  expect(() => decodeFrameOptions(withoutWorkspace, "/engine/")).toThrow("workspaceInUse requires workspaceId");
});
