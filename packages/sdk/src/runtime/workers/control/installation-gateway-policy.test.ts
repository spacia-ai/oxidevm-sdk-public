import { expect, it, vi } from "vitest";
import { installationGatewayPolicy } from "./installation-gateway-policy.js";

const policy = { origin: "https://registry.npmjs.org", maximumBytes: 1024 };
const lockfile = new TextEncoder().encode("lockfileVersion: '9.0'\n\npackages:\n\n  next@16.2.12:\n    resolution: {integrity: sha512-a}\n\n  '@img/colour@1.1.0':\n    resolution: {integrity: sha512-b}\n");
const frozen = { ...policy, frozenVersions: { next: ["16.2.12"], "@img/colour": ["1.1.0"] } };

/** The installer's cwd is guest-absolute under /workspace; the agent's file
 * service takes workspace-relative paths (a leading slash is the workspace
 * root), so the builder reads the relative form and records the guest path. */
it("reads the project's lockfile workspace-relative for a frozen install and leaves the policy alone otherwise", async () => {
  const readFile = vi.fn((path: string) => path === "/app/pnpm-lock.yaml" ? Promise.resolve(lockfile) : Promise.reject(new Error(`missing ${path}`)));
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace/app", frozenLockfile: true }, readFile))
    .resolves.toEqual({ policy: frozen, lockfile: { kind: "frozen", path: "/workspace/app/pnpm-lock.yaml", packages: 2 } });
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace/app", frozenLockfile: false }, readFile))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "not-frozen", detail: null } });
  expect(readFile.mock.calls.map(([path]) => path)).toEqual(["/app/pnpm-lock.yaml"]);
});

it("falls back to the workspace root lockfile and serves verbatim when none can be read", async () => {
  const rootOnly = vi.fn((path: string) => path === "/pnpm-lock.yaml" ? Promise.resolve(lockfile) : Promise.reject(new Error(`missing ${path}`)));
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace/packages/web", frozenLockfile: true }, rootOnly))
    .resolves.toEqual({ policy: frozen, lockfile: { kind: "frozen", path: "/workspace/pnpm-lock.yaml", packages: 2 } });
  expect(rootOnly.mock.calls.map(([path]) => path)).toEqual(["/packages/web/pnpm-lock.yaml", "/pnpm-lock.yaml"]);
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace", frozenLockfile: true }, rootOnly))
    .resolves.toEqual({ policy: frozen, lockfile: { kind: "frozen", path: "/workspace/pnpm-lock.yaml", packages: 2 } });
  expect(rootOnly.mock.calls.map(([path]) => path).slice(2)).toEqual(["/pnpm-lock.yaml"]);
  const none = vi.fn((path: string): Promise<Uint8Array> => Promise.reject(new Error(`missing ${path}`)));
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace/app", frozenLockfile: true }, none))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "unreadable", detail: "missing /pnpm-lock.yaml" } });
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace", frozenLockfile: true }, undefined))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "no-reader", detail: null } });
  const invalid = vi.fn(() => Promise.resolve(new Uint8Array([0xff, 0xfe])));
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace", frozenLockfile: true }, invalid))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "invalid-utf8", detail: null } });
  const empty = vi.fn(() => Promise.resolve(new TextEncoder().encode("lockfileVersion: '9.0'\n")));
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace", frozenLockfile: true }, empty))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "no-packages", detail: null } });
  const oversized = vi.fn(() => Promise.resolve(new Uint8Array(16 * 1024 * 1024 + 1)));
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace", frozenLockfile: true }, oversized))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "invalid-lockfile", detail: "pnpm lockfile exceeds its bound" } });
});

it("never reads for a cwd outside the workspace root", async () => {
  const readFile = vi.fn((): Promise<Uint8Array> => Promise.resolve(lockfile));
  await expect(installationGatewayPolicy(policy, { cwd: "/tmp/app", frozenLockfile: true }, readFile))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "outside-workspace", detail: null } });
  await expect(installationGatewayPolicy(policy, { cwd: "/workspace-other", frozenLockfile: true }, readFile))
    .resolves.toEqual({ policy, lockfile: { kind: "verbatim", reason: "outside-workspace", detail: null } });
  expect(readFile).not.toHaveBeenCalled();
});
