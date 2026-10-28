import { expect, it } from "vitest";
import { chmod, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageManagedIntegration } from "./managed-rootfs.js";
import { collectRootfs } from "./files.js";

it("injects the managed integration through guest /usr-merge links without following host paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-managed-root-"));
  try {
    await mkdir(join(root, "usr/sbin"), { recursive: true });
    await symlink("/usr/sbin", join(root, "sbin"));
    const metadata = await stageManagedIntegration(root, {
      agent: new TextEncoder().encode("native-agent"), init: new TextEncoder().encode("guest-init"),
    }, 123, new Map());
    expect(await readFile(join(root, "usr/sbin/oxidevm-init"), "utf8")).toBe("guest-init");
    const tree = await collectRootfs(root, undefined, undefined, metadata);
    expect(tree.entries.find(entry => entry.path === "usr/sbin/oxidevm-init")).toMatchObject({ mode: 0o755, ownership: { uid: 0, gid: 0 } });
    expect(tree.entries.find(entry => entry.path === "usr/libexec/oxidevm-agent")).toMatchObject({ mode: 0o755, ownership: { uid: 0, gid: 0 } });
    expect(await readFile(join(root, "usr/share/oxidevm/source-date-epoch"), "utf8")).toBe("123\n");
    const baseline = await readFile(join(root, "usr/share/oxidevm/workspace-baseline"));
    expect(baseline.subarray(0, 4).toString()).toBe("OXWB");
    expect(baseline.readUInt16LE(4)).toBe(3);
    expect(baseline.readUInt32LE(8)).toBe(1);
    expect(baseline.readBigInt64LE(12)).toBe(123_000_000_000n);
    expect(tree.entries.find(entry => entry.path === "usr/share/oxidevm/workspace-baseline")).toMatchObject({ mode: 0o644, ownership: { uid: 0, gid: 0 } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses a cyclic guest directory or an injected file symlink and preserves its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-managed-link-"));
  try {
    const integration = { agent: new Uint8Array([1]), init: new Uint8Array([2]) };
    await symlink("/sbin", join(root, "sbin"));
    await expect(stageManagedIntegration(root, integration, 0, new Map())).rejects.toThrow();
    await rm(join(root, "sbin")); await mkdir(join(root, "usr/libexec"), { recursive: true });
    await writeFile(join(root, "keep"), "keep"); await chmod(join(root, "keep"), 0o640);
    await symlink("/keep", join(root, "usr/libexec/oxidevm-agent"));
    await expect(stageManagedIntegration(root, integration, 0, new Map())).rejects.toThrow();
    expect(await readFile(join(root, "keep"), "utf8")).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("prepares final guest ownership through a workspace symlink and replaces an outdated baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-managed-baseline-"));
  try {
    await mkdir(join(root, "srv/project"), { recursive: true });
    await symlink("/srv/project", join(root, "workspace"));
    await writeFile(join(root, "srv/project/note"), "hello");
    await link(join(root, "srv/project/note"), join(root, "srv/project/alias"));
    await mkdir(join(root, "usr/share/oxidevm"), { recursive: true });
    const file = join(root, "usr/share/oxidevm/workspace-baseline");
    await writeFile(file, "outdated");
    const metadata = new Map(["srv/project", "srv/project/note", "srv/project/alias"].map(path => [path, { mode: 0o750, ownership: { uid: 123, gid: 456 } }]));
    await stageManagedIntegration(root, { agent: new Uint8Array([1]), init: new Uint8Array([2]) }, 123, metadata);
    const baseline = await readFile(file);
    expect(baseline.subarray(0, 4).toString()).toBe("OXWB");
    expect(baseline.readUInt32LE(8)).toBe(3);
    expect(baseline.readUInt32LE(40)).toBe(123);
    expect(baseline.readUInt32LE(44)).toBe(456);
    expect(baseline.readUInt16LE(22)).toBe(0o750);
    await rm(file); await symlink("/keep", file); await writeFile(join(root, "keep"), "preserved");
    await expect(stageManagedIntegration(root, { agent: new Uint8Array([1]), init: new Uint8Array([2]) }, 123, metadata)).rejects.toThrow("regular guest file");
    expect(await readFile(join(root, "keep"), "utf8")).toBe("preserved");
  } finally { await rm(root, { recursive: true, force: true }); }
});
