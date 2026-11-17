import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { lateFailureOf } from "../../js-process/late-failure.js";
import { clearRefusedNodeApi, refusedNodeApi, unavailableNodeApi } from "./node-capability.js";

it("names an API without a browser contract as a late failure, so a program that dies of it is remembered (ADR 0026)", () => {
  let thrown: unknown;
  try { unavailableNodeApi("sqlite.DatabaseSync"); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(VMError);
  expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", message: "sqlite.DatabaseSync is unavailable in browser-assisted processes", detail: { api: "sqlite.DatabaseSync" } });
  expect(lateFailureOf(thrown)).toEqual({ kind: "unavailable-builtin", detail: "node:sqlite.DatabaseSync" });
});

it("keeps the API a process was last refused, for a program that catches the refusal and then exits with a failure", () => {
  clearRefusedNodeApi();
  expect(refusedNodeApi()).toBeUndefined();
  for (const api of ["sqlite.DatabaseSync", "v8.getHeapStatistics"]) { try { unavailableNodeApi(api); } catch { /* caught, as npm catches it */ } }
  expect(refusedNodeApi()).toEqual({ kind: "unavailable-builtin", detail: "node:v8.getHeapStatistics" });
  clearRefusedNodeApi();
  expect(refusedNodeApi()).toBeUndefined();
});
