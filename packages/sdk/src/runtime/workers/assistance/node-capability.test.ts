import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { lateFailureOf } from "../../js-process/late-failure.js";
import { unavailableNodeApi } from "./node-capability.js";

it("names an API without a browser contract as a late failure, so a program that dies of it is remembered (ADR 0026)", () => {
  let thrown: unknown;
  try { unavailableNodeApi("sqlite.DatabaseSync"); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(VMError);
  expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", message: "sqlite.DatabaseSync is unavailable in browser-assisted processes", detail: { api: "sqlite.DatabaseSync" } });
  expect(lateFailureOf(thrown)).toEqual({ kind: "unavailable-builtin", detail: "node:sqlite.DatabaseSync" });
});
