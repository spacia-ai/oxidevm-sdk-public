import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeAssistanceVmRequest, encodeAssistanceVmRequest, matchAssistanceVmReply } from "./assistance-vm.ts";

it("accepts only the exact VM operation completion", () => {
  const request = { session: "11111111-2222-4333-8444-555555555555", generation: 1, sequence: 2, operation: "fence" as const };
  expect(() => matchAssistanceVmReply(request, encodeAssistanceVmRequest(request))).not.toThrow();
  for (const patch of [{ session: "11111111-2222-4333-8444-555555555556" }, { generation: 2 }, { sequence: 3 }, { operation: "ping" }]) {
    expect(() => matchAssistanceVmReply(request, encodeAssistanceVmRequest({ ...request, ...patch }))).toThrow("VM completion");
  }
});

it("uses VM identities without fabricated processes and shares v5 supervision goldens", () => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/vm-request-v5.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const [kind, hex] = line.split(" ");
    if (hex === undefined) throw new Error("invalid fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const request = decodeAssistanceVmRequest(bytes);
    expect(request.operation).toBe(kind);
    expect(encodeAssistanceVmRequest(request)).toEqual(bytes);
    expect(() => encodeAssistanceVmRequest({ ...request, process: 1 })).toThrow();
    expect(() => encodeAssistanceVmRequest({ ...request, sequence: 0 })).toThrow();
    for (let end = 0; end < bytes.length; end++) expect(() => decodeAssistanceVmRequest(bytes.slice(0, end))).toThrow();
    expect(() => decodeAssistanceVmRequest(Uint8Array.from([...bytes, 0]))).toThrow();
  }
});
