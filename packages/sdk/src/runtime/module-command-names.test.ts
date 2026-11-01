import { expect, it } from "vitest";
import { isModuleCommandName, moduleCommandPath } from "./module-command-names.js";

it("accepts the module command names Rust accepts and names each stub's path", () => {
  for (const name of ["a", "python3", "g++", "x.y_z-1", "0day", "a".repeat(64), "oxide"]) expect(isModuleCommandName(name), name).toBe(true);
  for (const name of ["", "A", "Python", "-x", ".x", "_x", "+x", "a".repeat(65), "a/b", "a b", "é", "a\0", "oxidevm", "oxidevm-tool", "oxidevmx"]) expect(isModuleCommandName(name), name).toBe(false);
  expect(moduleCommandPath("typst")).toBe("/usr/local/bin/typst");
});
