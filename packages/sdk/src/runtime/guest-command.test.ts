import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { nativeGuestCommand } from "./guest-command.js";

const execute = promisify(execFile);
it("keeps command arguments as literal operands during native shell PATH admission", async () => {
  const values = ["a b", "$(printf injected)", "`; exit 99; #", "one\ntwo", "\"quoted\"", "\\backslash"];
  const command = nativeGuestCommand("printf", ["%s\n", ...values]);
  const result = await execute(command.executable, command.arguments.slice(1), { env: { PATH: "/usr/bin:/bin" } });
  expect(result.stdout).toBe(`${values.join("\n")}\n`);
  expect(result.stderr).toBe("");
});
it("retains actual command failure instead of manufacturing successful process output", async () => {
  const command = nativeGuestCommand("sh", ["-c", "printf failure >&2; exit 7"]);
  await expect(execute(command.executable, command.arguments.slice(1), { env: { PATH: "/usr/bin:/bin" } }))
    .rejects.toMatchObject({ code: 7, stdout: "", stderr: "failure" });
});
it("preserves absolute executable admission without requiring a shell in minimal images", () => {
  expect(nativeGuestCommand("/usr/bin/python3", ["-c", "print(42)"])).toEqual({ executable: "/usr/bin/python3", arguments: ["/usr/bin/python3", "-c", "print(42)"] });
});
it("admits a script whose command name begins with a dash through the actual PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-command-"));
  try {
    const file = join(directory, "-script");
    await writeFile(file, '#!/bin/sh\nprintf "%s" "$1"\n'); await chmod(file, 0o700);
    const command = nativeGuestCommand("-script", ["literal command operand"]);
    const result = await execute(command.executable, command.arguments.slice(1), { env: { PATH: `${directory}:/usr/bin:/bin` } });
    expect(result.stdout).toBe("literal command operand"); expect(result.stderr).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
