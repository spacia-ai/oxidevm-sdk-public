import { expect, it } from "vitest";
import { doctorAssetBase, doctorPreviewFrame } from "../contracts/doctor-url.js";
it("resolves runtime assets beside the deployed probe for default and relocated asset bases", () => {
  expect(doctorAssetBase("https://app.example/oxidevm/doctor/client.js").href).toBe("https://app.example/oxidevm/");
  expect(doctorAssetBase("https://cdn.example/custom/runtime-assets/doctor/client.js").href).toBe("https://cdn.example/custom/runtime-assets/");
});
it("probes a session origin when the preview host differs from its parent", () => {
  const session = "a".repeat(32);
  const value = doctorPreviewFrame("http://preview.localhost:4278", "http://127.0.0.1:4273", session);
  expect(value.origin).toBe(`http://${session}.preview.localhost:4278`);
  const url = new URL(value.url);
  expect(url.pathname).toBe("/__oxidevm/index.html");
  expect(url.searchParams.get("parentOrigin")).toBe("http://127.0.0.1:4273");
  expect(url.searchParams.get("session")).toBe(session);
  expect(url.searchParams.has("isolation")).toBe(false);
});
it("uses explicit shared development isolation only on the parent's host", () => {
  const value = doctorPreviewFrame("http://localhost:4278", "http://localhost:4273", "b".repeat(32));
  expect(value.origin).toBe("http://localhost:4278");
  expect(new URL(value.url).searchParams.get("isolation")).toBe("shared");
});
