import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

beforeEach(() => {
  vi.stubGlobal("Worker", ScriptedWorker);
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  ScriptedWorker.answers.set("resize-system-console", () => undefined);
});
afterEach(() => { ScriptedWorker.reset(); vi.unstubAllGlobals(); });

it("forwards console geometry and rejects invalid or cancelled resizes before sending", async () => {
  const vm = await bootedManagedVm();
  const control = ScriptedWorker.named("oxidevm-control");
  await vm.diagnostics.resizeSystemConsole({ columns: 120, rows: 36 });
  expect(control.inputs.filter(input => input["type"] === "resize-system-console"))
    .toMatchObject([{ columns: 120, rows: 36 }]);
  for (const size of [{ columns: 0, rows: 24 }, { columns: 80, rows: 1001 }, { columns: 1.5, rows: 24 }]) {
    expect(() => vm.diagnostics.resizeSystemConsole(size)).toThrowError("console dimensions must be integers from 1 to 1000");
  }
  await expect(vm.diagnostics.resizeSystemConsole({ columns: 80, rows: 24 }, { signal: AbortSignal.abort() }))
    .rejects.toMatchObject({ code: "ABORTED" });
  expect(control.inputs.filter(input => input["type"] === "resize-system-console")).toHaveLength(1);
  await vm.dispose();
});
