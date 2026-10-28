import { describe, expect, it } from "vitest";
import { Readable, Writable } from "./node-streams.js";
import { createNodeReadline } from "./node-readline.js";

describe("node readline builtin", () => {
  it("splits input into lines, answers questions, prompts and closes", async () => {
    const readline = createNodeReadline();
    const input = new Readable({ read() { /* pushed below */ } });
    const written: string[] = [];
    const output = new Writable({ write(chunk: unknown, _encoding: unknown, callback: () => void) { written.push(String(chunk)); callback(); } });
    const rl = readline.createInterface({ input, output, prompt: "> " });
    const lines: string[] = [];
    rl.on("line", (line: unknown) => { if (typeof line === "string") lines.push(line); });
    const closed = new Promise<void>(resolve => { rl.on("close", () => { resolve(); }); });
    const answer = new Promise<unknown>(resolve => { rl.question("name? ", (value: unknown) => { resolve(value); }); });
    input.push(new TextEncoder().encode("Ada\r\nsecond line\npartial"));
    expect(await answer).toBe("Ada");
    rl.prompt();
    input.push(null);
    await closed;
    expect(lines).toEqual(["second line", "partial"]);
    expect(written).toEqual(["name? ", "> "]);
    expect(rl.terminal).toBe(false);
    expect(() => readline.createInterface({})).toThrow(/input/u);
  });
});
