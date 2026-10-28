import { expect, it } from "vitest";
import { engineDownload, engineRelease, engineReleaseId } from "./engine.generated.js";
import { decodeEngineDownload, pinnedEngineRelease } from "./image-builder/engine-source.js";
import { CORE_API_VERSION, JIT_API_VERSION } from "./runtime/core-abi.js";
import { USERSPACE_API_VERSION } from "./runtime/userspace-abi.js";
import { NETSTACK_API_VERSION } from "./runtime/netstack-abi.js";
import { sha256Hex } from "./runtime/workers/snapshot-content.js";

it("pins one engine release whose exact release.json bytes hash to its ID", async () => {
  const bytes = new TextEncoder().encode(`${JSON.stringify(engineRelease, null, 2)}\n`);
  expect(await sha256Hex(bytes)).toBe(engineReleaseId);
  expect(pinnedEngineRelease()).toMatchObject({ id: engineReleaseId, manifestBytes: bytes.length });
});

it("pins an engine built for exactly this SDK's ABI identities", () => {
  // A skewed engine and SDK pair must fail here, not in a browser.
  expect(engineRelease.identities).toEqual({ coreApi: CORE_API_VERSION, jitAbi: JIT_API_VERSION, userspaceApi: USERSPACE_API_VERSION, netstackApi: NETSTACK_API_VERSION });
});

it("records no download location, the CDN directory of release <id>, or its six release assets", () => {
  const download = decodeEngineDownload(engineDownload, engineReleaseId);
  if (download?.kind === "cdn") expect(download.baseUrl.endsWith(`/engine/${engineReleaseId}/`)).toBe(true);
  if (download?.kind === "github-release-assets") expect(Object.keys(download.assets).sort()).toEqual(["LICENSE", ...engineRelease.artifacts.map(artifact => artifact.name), "release.json"].sort());
  expect(pinnedEngineRelease().download).toEqual(download);
});
