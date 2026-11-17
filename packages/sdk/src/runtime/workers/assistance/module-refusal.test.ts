import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { refusingModules } from "./module-refusal.js";

const outside = (path: string) => new VMError("FEATURE_NOT_AVAILABLE", "installed module is outside the admitted dependency generation", { lateFailure: "unadmitted-module", subject: path });

it("keeps the first refused module a program catches, by its path", () => {
  const kept = refusingModules({
    resolve(specifier) { if (specifier === "vite") throw outside("/workspace/app/node_modules/vite/index.js"); return specifier; },
    read(path) { if (path === "/elsewhere/a.js") throw outside(path); return { source: "", format: "commonjs" }; },
  });
  expect(kept.refused()).toBeUndefined();
  expect(kept.modules.resolve("./local.js", "/workspace/app/index.js", "require")).toBe("./local.js");
  expect(() => kept.modules.resolve("vite", "/workspace/app/vite.config.ts", "import")).toThrow(VMError);
  expect(kept.refused()).toEqual({ kind: "unadmitted-module", detail: "/workspace/app/node_modules/vite/index.js" });
  // The first refusal names the cause; a later one does not replace it.
  expect(() => kept.modules.read("/elsewhere/a.js")).toThrow(VMError);
  expect(kept.refused()).toEqual({ kind: "unadmitted-module", detail: "/workspace/app/node_modules/vite/index.js" });
});

it("does not take an ordinary resolution error for a limitation", () => {
  const missing = Object.assign(new Error("Cannot find module 'x'"), { code: "MODULE_NOT_FOUND" });
  const kept = refusingModules({ resolve() { throw missing; }, read: () => ({ source: "", format: "commonjs" }) });
  expect(() => kept.modules.resolve("x", "/workspace/app/index.js", "require")).toThrow(missing);
  expect(kept.refused()).toBeUndefined();
});
