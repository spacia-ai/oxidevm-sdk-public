import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hash } from "./files.js";
import { createAccelerationProfile, type AccelerationProfileOptions } from "./acceleration.js";

it("binds explicit native runtime requirements at profile version seven", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-runtime-profile-"));
  try {
    const artifact = { path: join(root, "artifact"), sha256: hash("fixture") }; await writeFile(artifact.path, "fixture");
    const options = { profile: "native-parity-fixture-v1", platform: { os: "linux", architecture: "x86_64", libc: "musl", cpu: "x86-64-v3" }, capability: "node-api-experimental-v1", dependencies: "/workspace/node_modules", host: artifact, addons: [] } as const;
    for (const requiredRuntime of ["node", "bun"] as const) {
      for (const requiredCapabilities of [undefined, ["promise-is-promise-v1"], ["error-is-error-v1"], ["promise-is-promise-v1", "error-is-error-v1"]] as const) {
        const result = await createAccelerationProfile({ ...options, requiredRuntime, ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }) });
        const text = new TextDecoder().decode(result.bytes);
        expect(text).toMatch(/^OXAP\t7\n/u); expect(text).toContain(`requires-runtime\t${requiredRuntime}\n`);
        expect(text.includes("requires\t")).toBe(requiredCapabilities !== undefined);
      }
    }
    for (const requiredRuntime of ["", "node24", "unknown", 0, null, [], {}])
      await expect(Reflect.apply(createAccelerationProfile, undefined, [{ ...options, requiredRuntime }])).rejects.toThrow();
    await expect(Reflect.apply(createAccelerationProfile, undefined, [{ profile: "node24-bun1-v1", dependencies: options.dependencies, host: artifact, addons: [], requiredRuntime: "node" }])).rejects.toThrow();
    expect(new TextDecoder().decode((await createAccelerationProfile(options)).bytes)).toMatch(/^OXAP\t2\n/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("pins exact Promise requirements at a new profile boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-promise-profile-"));
  try {
    const artifact = { path: join(root, "artifact"), sha256: hash("fixture") }; await writeFile(artifact.path, "fixture");
    const options = { profile: "native-parity-fixture-v1", platform: { os: "linux", architecture: "x86_64", libc: "musl", cpu: "x86-64-v3" }, capability: "node-api-experimental-v1", dependencies: "/workspace/node_modules", host: artifact, addons: [], requiredCapabilities: ["promise-is-promise-v1"] } as const;
    const text = new TextDecoder().decode((await createAccelerationProfile(options)).bytes);
    expect(text).toMatch(/^OXAP\t5\n/u); expect(text).toContain("requires\tpromise-is-promise-v1\n");
    for (const requiredCapabilities of [["error-is-error-v1"], ["promise-is-promise-v1", "error-is-error-v1"]] as const) {
      const result: unknown = await Reflect.apply(createAccelerationProfile, undefined, [{ ...options, requiredCapabilities }]);
      if (typeof result !== "object" || result === null || !("bytes" in result) || !(result.bytes instanceof Uint8Array)) throw new Error("Missing profile bytes");
      const profile = new TextDecoder().decode(result.bytes);
      expect(profile).toMatch(/^OXAP\t6\n/u); expect(profile).toContain(`requires\t${requiredCapabilities.join("\t")}\n`);
    }
    for (const requiredCapabilities of [[], ["unknown"], ["promise-is-promise-v1", "promise-is-promise-v1"], 1, null]) await expect(Reflect.apply(createAccelerationProfile, undefined, [{ ...options, requiredCapabilities }])).rejects.toThrow();
    for (const requiredCapabilities of [["error-is-error-v1", "error-is-error-v1"], ["error-is-error-v1", "promise-is-promise-v1"], ["promise-is-promise-v1", "error-is-error-v1", "unknown"]]) await expect(Reflect.apply(createAccelerationProfile, undefined, [{ ...options, requiredCapabilities }])).rejects.toThrow();
    await expect(Reflect.apply(createAccelerationProfile, undefined, [{ profile: "node24-bun1-v1", dependencies: options.dependencies, host: artifact, addons: [], requiredCapabilities: options.requiredCapabilities }])).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("versions vendored libraries and confines them to the captured dependency root", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-vendored-library-"));
  try {
    const artifact = { path: join(root, "library"), sha256: hash("library") }; await writeFile(artifact.path, "library");
    const library = { name: "libexample.so.1", path: "/workspace/node_modules/.pnpm/bundle/lib/libexample.so.1", artifact };
    const options = { profile: "native-parity-fixture-v1", platform: { os: "linux", architecture: "x86_64", libc: "musl", cpu: "x86-64-v3" }, capability: "node-api-experimental-v1", dependencies: "/workspace/node_modules", host: artifact, addons: [], libraries: [library] } as const;
    const text = new TextDecoder().decode((await createAccelerationProfile(options)).bytes);
    expect(text).toMatch(/^OXAP\t4\n/u); expect(text).toContain(`library\t${library.name}\t${artifact.sha256}\t${library.path}\n`);
    for (const path of ["/workspace/other/libexample.so.1", "/workspace/node_modules-other/libexample.so.1", "/workspace/node_modules/../libexample.so.1"])
      await expect(createAccelerationProfile({ ...options, libraries: [{ ...library, path }] })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("pins shared libraries in a new profile boundary and rejects duplicate identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-library-profile-"));
  try {
    const artifact = { path: join(root, "library"), sha256: hash("library") }; await writeFile(artifact.path, "library");
    const library = { name: "libuv.so.1", path: "/usr/lib/libuv.so.1", artifact };
    const options = { profile: "native-parity-fixture-v1", platform: { os: "linux", architecture: "x86_64", libc: "musl", cpu: "x86-64-v3" }, capability: "node-api-experimental-v1", dependencies: "/workspace/node_modules", host: artifact, addons: [], libraries: [library] } as const;
    const result = await createAccelerationProfile(options), text = new TextDecoder().decode(result.bytes);
    expect(text).toMatch(/^OXAP\t3\n/u); expect(text).toContain(`library\tlibuv.so.1\t${artifact.sha256}\t/usr/lib/libuv.so.1\n`);
    for (const libraries of [[library, library], [{ ...library, name: "../libuv.so.1" }], [{ ...library, path: "/usr/lib/../libuv.so.1" }]]) await expect(Reflect.apply(createAccelerationProfile, undefined, [{ ...options, libraries }])).rejects.toThrow();
    await writeFile(artifact.path, "changed"); await expect(createAccelerationProfile(options)).rejects.toThrow(/digest/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("authors an unrelated byte-pinned qualification addon without a package-name registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-generic-profile-"));
  try {
    const artifact = { path: join(root, "artifact"), sha256: hash("unrelated fixture") };
    await writeFile(artifact.path, "unrelated fixture");
    const options = {
      profile: "native-parity-fixture-v1", platform: { os: "linux", architecture: "x86_64", libc: "musl", cpu: "x86-64-v3" },
      capability: "node-api-experimental-v1", dependencies: "/workspace/node_modules", host: artifact,
      addons: [{ path: "/workspace/node_modules/unrelated/addon.node", artifact }],
    } as const;
    const result = await createAccelerationProfile(options);
    expect(new TextDecoder().decode(result.bytes)).toBe(`OXAP\t2\nprofile\tnative-parity-fixture-v1\nplatform\tlinux-x86_64\tmusl\tx86-64-v3\ncapability\tnode-api-experimental-v1\nhost\t${artifact.sha256}\t/usr/local/libexec/oxidevm-node-api-host\ndependencies\t/workspace/node_modules\nartifact\tnode-api\t${artifact.sha256}\t/workspace/node_modules/unrelated/addon.node\n`);
    for (const patch of [{ capability: "complete-node-api-10" }, { platform: { ...options.platform, cpu: "x86-64-v4" } }, { addons: [...options.addons, ...options.addons] }]) {
      await expect(Reflect.apply(createAccelerationProfile, undefined, [{ ...options, ...patch }])).rejects.toThrow();
    }
    await writeFile(artifact.path, "modified after pin");
    await expect(Reflect.apply(createAccelerationProfile, undefined, [options])).rejects.toThrow(/digest/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([{ name: "rollup", version: "4.64.2" }, { name: "swc", version: "1.16.13" }] as const)("authors the qualified managed Vite addon $name@$version", async qualified => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-vite-profile-"));
  try {
    const artifact = { path: join(root, "artifact"), sha256: hash("fixture") };
    await writeFile(artifact.path, "fixture");
    const profile = { profile: "node24-bun1-v1", dependencies: "/workspace/node_modules", host: artifact,
      addons: [{ ...qualified, path: `/workspace/node_modules/${qualified.name}.node`, artifact }] } as const;
    const result = await createAccelerationProfile(profile);
    expect(new TextDecoder().decode(result.bytes)).toContain(`addon\t${qualified.name}\t${qualified.version}\t/workspace/node_modules/${qualified.name}.node\n`);
    await expect(Reflect.apply(createAccelerationProfile, undefined, [{ ...profile, addons: [{ ...profile.addons[0], version: "unqualified" }] }])).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("builds profile metadata from pinned artifacts without inventorying editable scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-profile-"));
  try {
    const host = join(root, "host"), addon = join(root, "addon"); await writeFile(host, "host"); await writeFile(addon, "addon");
    const options: AccelerationProfileOptions = { profile: "node24-bun1-v1", dependencies: "/workspace/node_modules", host: { path: host, sha256: hash("host") }, addons: [{ name: "next", version: "16.2.12", path: "/workspace/node_modules/@next/swc-linux-x64-musl/next-swc.linux-x64-musl.node", artifact: { path: addon, sha256: hash("addon") } }] };
    const file = await createAccelerationProfile(options);
    expect(file.path).toBe("/usr/local/share/oxidevm/acceleration.profile");
    expect(new TextDecoder().decode(file.bytes)).toBe(`OXAP\t1\nprofile\tnode24-bun1-v1\nhost\t${hash("host")}\t/usr/local/libexec/oxidevm-node-api-host\ndependencies\t/workspace/node_modules\naddon\tnext\t16.2.12\t${options.addons[0]?.path}\n`);
    await writeFile(addon, "changed"); await expect(createAccelerationProfile(options)).rejects.toThrow(/digest/u);
    await expect(createAccelerationProfile({ ...options, dependencies: "/workspace/../node_modules" })).rejects.toThrow(/path/u);
    await expect(createAccelerationProfile({ ...options, addons: [...options.addons, ...options.addons] })).rejects.toThrow(/duplicate/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
