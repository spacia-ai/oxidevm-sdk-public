import { expect, it } from "vitest";
import { decodeAccessLine, verifyExecutable, nginxConfig } from "./server.ts";

it("accepts only nginx's bounded access records, not invented iframe status", () => {
  expect(decodeAccessLine('{"status":200,"path":"/index.html"}')).toEqual({ status: 200, path: "/index.html" });
  for (const value of ['{}', '{"status":"200","path":"/"}', '{"status":999,"path":"/"}', '{"status":200,"path":"/","extra":1}', 'x'.repeat(4097)]) {
    expect(decodeAccessLine(value)).toBeNull();
  }
});

it("checks the guest executable's ELF class, byte order and x86-64 machine", () => {
  const bytes = new Uint8Array(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); bytes[18] = 62;
  expect(() => verifyExecutable(bytes)).not.toThrow();
  for (const index of [0, 4, 5, 18, 19]) {
    const wrong = bytes.slice(); wrong[index] = 9;
    expect(() => verifyExecutable(wrong)).toThrow("Linux x86-64 ELF");
  }
  expect(() => verifyExecutable(bytes.slice(0, 19))).toThrow();
});

it("keeps nginx unprivileged, uncached and inside its writable workspace", () => {
  expect(nginxConfig).toContain("listen 8080");
  expect(nginxConfig).toContain("root /workspace/site");
  expect(nginxConfig).toContain('add_header Cache-Control "no-store" always');
  expect(nginxConfig).toContain("pid /tmp/oxidevm-nginx.pid");
});
