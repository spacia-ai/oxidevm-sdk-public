import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { record, string } from "../../decode.js";
import { SYSTEM_ERROR_MESSAGES, systemErrorMessage } from "./node-system-errors.js";

const control = record(JSON.parse(readFileSync(new URL("./node-system-errors.controls.json", import.meta.url), "utf8")), "system error controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-system-errors.cjs", import.meta.url));
const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new TypeError("not a list"); return value; };

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("holds exactly pinned Node's libuv messages", () => {
  const recorded = Object.fromEntries(list(control["errors"]).map(value => { const row = record(value, "error"); return [string(row["code"], "code"), string(row["message"], "message")]; }));
  expect(SYSTEM_ERROR_MESSAGES).toEqual(recorded);
});

it("words a Linux failure as Node's uvException does", () => {
  for (const value of list(control["messages"])) {
    const row = record(value, "message");
    const path = row["path"], dest = row["dest"];
    expect(systemErrorMessage(string(row["code"], "code"), string(row["syscall"], "syscall"), typeof path === "string" ? path : null, typeof dest === "string" ? dest : null)).toBe(row["message"]);
  }
  expect(systemErrorMessage("EUNKNOWNCODE", "open", "/x", null)).toBe("EUNKNOWNCODE: open");
});
