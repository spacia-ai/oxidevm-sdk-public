import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { runCLI } from "./run.js";

vi.mock("./starter.generated.js", async () => {
  const { getSDKRelease } = await import("@oxidevm/sdk/image-builder");
  const sdk = getSDKRelease(), engine = sdk.engineRelease.slice("sha256:".length), digest = "d".repeat(64);
  const compliance = { url: `https://cdn.oxidevm.dev/engine/${engine}/compliance/${digest}/compliance.json`, bytes: 100, sha256: digest };
  return { starterRelease: { schemaVersion: 2, sdkVersion: sdk.sdkVersion, engineRelease: engine, engineCompliance: compliance,
    image: { mode: "userspace", manifestUrl: `https://cdn.oxidevm.dev/images/oxidevm-starter-nginx/0.0.2/${"a".repeat(64)}/manifest.json`, manifestSHA256: "a".repeat(64), trust: { algorithm: "Ed25519", keyId: "fixture", publicKey: "MCowBQYDK2VwAyEAqa1J60wlujbHvQ5zc11ydVv2ZlAFvjX7FyMwF6Yn3cs=" } },
    archive: { url: "https://cdn.oxidevm.dev/images/oxidevm-starter-nginx/0.0.2/bundle.tgz", bytes: 1000, sha256: "b".repeat(64) }, materialsSHA256: "c".repeat(64), materialsUrl: "https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.2/OPEN-SOURCE-NOTICE.md" } };
});

it("normal init creates a hosted starter without downloading engine, image or compliance files", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-hosted-starter-"));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("The creator must not download browser assets"));
  try {
    const stdout: string[] = [], stderr: string[] = [];
    const code = await runCLI(["init", "app", "--json"], { directory: root, environment: {}, signal: new AbortController().signal, stdout: value => { stdout.push(value); }, stderr: value => { stderr.push(value); } });
    expect(code, stderr.join("\n") + stdout.join("\n")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(root, "app/src/runtime.ts"), "utf8")).toContain('hosting: "frame"');
    expect(await readFile(join(root, "app/src/image.ts"), "utf8")).toContain("https://cdn.oxidevm.dev/images/");
    expect(await readFile(join(root, "app/src/production-image.ts"), "utf8")).toEqual(await readFile(join(root, "app/src/image.ts"), "utf8"));
    await expect(readdir(join(root, "app/.oxidevm"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
