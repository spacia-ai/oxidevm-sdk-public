import { expect, it } from "vitest";
import { previewRequestBody } from "./request-body";

it("finishes GET and HEAD when the browser does not expose Request.body", () => {
  for (const method of ["GET", "HEAD"]) {
    const request = new Request("https://preview.example/", { method });
    Object.defineProperty(request, "body", { value: undefined });
    expect(previewRequestBody(request)).toBeNull();
  }
});

it("rejects an unavailable upload stream without reading or dropping the body", () => {
  const request = new Request("https://preview.example/", { method: "POST", body: "keep this body" });
  Object.defineProperty(request, "body", { value: undefined });
  expect(() => previewRequestBody(request)).toThrow("streaming request bodies");
  expect(request.bodyUsed).toBe(false);
});

it("preserves supported request streams and empty bodies", () => {
  const request = new Request("https://preview.example/", { method: "POST", body: "body" });
  expect(previewRequestBody(request)).toBe(request.body);
  expect(previewRequestBody(new Request("https://preview.example/", { method: "POST" }))).toBeNull();
});
