import { expect, it } from "vitest";
import runtime from "./runtime.ts";

it("uses the hosted runtime without a development origin or local engine path", () => {
  expect(runtime).toEqual({ hosting: "frame" });
});
