import { afterEach, expect, it, vi } from "vitest";
import { eraseLocalData } from "./local-data.js";
import { ScriptedWorker } from "./runtime/system-vm.test-support.js";

afterEach(() => { ScriptedWorker.reset(); vi.unstubAllGlobals(); });

it("erases this origin for a self-hosted runtime and routes frame mode to the runtime frame", async () => {
  vi.stubGlobal("Worker", ScriptedWorker);
  ScriptedWorker.answers.set("erase-local-data", () => undefined);
  await eraseLocalData({ runtime: { hosting: "self-hosted", baseUrl: "/oxidevm/runtime/" } });
  await eraseLocalData();
  expect(ScriptedWorker.instances).toHaveLength(2);
  // Frame mode never erases this page's own origin: it needs the frame, which needs isolation.
  vi.stubGlobal("crossOriginIsolated", false);
  await expect(eraseLocalData({ runtime: { hosting: "frame" } })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { requirement: "cross-origin-isolation" } });
  expect(ScriptedWorker.instances).toHaveLength(2);
  await expect(Reflect.apply(eraseLocalData, undefined, [{ runtime: { hosting: "elsewhere" } }])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(Reflect.apply(eraseLocalData, undefined, [{ runtime: { hosting: "frame", origin: "http://evil.example" } }])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});
