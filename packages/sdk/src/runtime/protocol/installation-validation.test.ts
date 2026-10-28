import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { encodeInstallationRequest, decodeInstallationRequest } from "./assistance-installation.js";

for (const [kind, golden] of [["validate-inputs", "installation-input-validation-v7.hex"], ["blocked-builds", "installation-blocked-builds-v7.hex"]])
it(`admits ${kind ?? ""} only in guest 7 and retains its retirement sequence`, () => {
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, installation: 1, sequence: 42,
    operation: { kind } };
  const bytes = encodeInstallationRequest(request, 7);
  expect(Buffer.from(bytes).toString("hex")).toBe(readFileSync(new URL(`../../../../../tests/fixtures/assistance/${golden ?? ""}`, import.meta.url), "utf8").trim());
  expect(decodeInstallationRequest(bytes, 7)).toEqual(request);
  expect(() => encodeInstallationRequest(request, 6)).toThrow();
  expect(() => decodeInstallationRequest(bytes, 6)).toThrow();
  expect(() => encodeInstallationRequest({ ...request, sequence: 0xffff_ffff }, 7)).toThrow();
});
