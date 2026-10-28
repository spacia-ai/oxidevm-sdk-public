import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { installationGatewayPolicy } from "./installation-gateway-policy.js";

const LOCK = readFileSync(new URL("../../../../../../tests/fixtures/assistance/next-app.pnpm-lock.yaml", import.meta.url));
const POLICY = { origin: "https://registry.npmjs.org", maximumBytes: 64 * 1024 * 1024 };

describe("installationGatewayPolicy on the App fixture lockfile", () => {
  it("names next 16.2.12 and the scoped SWC package under the project's cwd", async () => {
    const reads: string[] = [];
    const { policy, lockfile } = await installationGatewayPolicy(POLICY, { cwd: "/workspace/app", frozenLockfile: true }, path => {
      reads.push(path);
      if (path === "/app/pnpm-lock.yaml") return Promise.resolve(new Uint8Array(LOCK));
      return Promise.reject(new Error("ENOENT"));
    });
    expect(reads).toEqual(["/app/pnpm-lock.yaml"]);
    expect(lockfile).toEqual({ kind: "frozen", path: "/workspace/app/pnpm-lock.yaml", packages: Object.keys(policy.frozenVersions ?? {}).length });
    expect(policy.frozenVersions?.["next"]).toEqual(["16.2.12"]);
    expect(Object.keys(policy.frozenVersions ?? {}).length).toBeGreaterThan(50);
    expect(policy.frozenVersions?.["@next/swc-linux-x64-musl"]).toEqual(["16.2.12"]);
  });
});
