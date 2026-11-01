import { expect, it } from "vitest";
import { LinuxError } from "../../runtime/js-process/codec.js";
import { ALL_FEATURES } from "./harness.test-support.js";
import { COMMAND_DECLARATION, buildRelease } from "./fixtures.test-support.js";
import { missingPrerequisites } from "./prerequisites.js";

const manifestWith = async (requires: Record<string, unknown>) => (await buildRelease({ adapter: "export default () => ({ main: () => 0 });", declaration: { ...COMMAND_DECLARATION, requires: { host: [], ...requires } } })).manifest;

it("names each missing browser feature and nothing when every feature is present", async () => {
  const manifest = await manifestWith({ browser: ["cross-origin-isolated", "indexeddb", "jspi", "web-locks"] });
  const none = { crossOriginIsolated: false, indexedDB: false, jspi: false, webLocks: false };
  expect(await missingPrerequisites(manifest, none, { stat: () => Promise.reject(new Error("unused")) })).toEqual([
    "browser feature cross-origin-isolated", "browser feature indexeddb", "browser feature jspi", "browser feature web-locks",
  ]);
  expect(await missingPrerequisites(manifest, ALL_FEATURES, { stat: () => Promise.reject(new Error("unused")) })).toEqual([]);
});

it("checks guest executables as files with an execute bit, and propagates unexpected errors", async () => {
  const manifest = await manifestWith({ guest: { executables: ["/bin/ok", "/bin/absent", "/bin/plain", "/bin/dir"] } });
  const modes: Readonly<Record<string, number>> = { "/bin/ok": 0o100755, "/bin/plain": 0o100644, "/bin/dir": 0o040755 };
  const stat = (path: string) => { const mode = modes[path]; return mode === undefined ? Promise.reject(new LinuxError(2)) : Promise.resolve({ device: 0n, inode: 0n, links: 1n, mode, uid: 0, gid: 0, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n }); };
  expect(await missingPrerequisites(manifest, ALL_FEATURES, { stat })).toEqual([
    "guest executable /bin/absent", "guest executable /bin/dir (not an executable file)", "guest executable /bin/plain (not an executable file)",
  ]);
  await expect(missingPrerequisites(manifest, ALL_FEATURES, { stat: () => Promise.reject(new LinuxError(13)) })).rejects.toBeInstanceOf(LinuxError);
});

it("reads each browser feature from its own flag, not from a neighbour's", async () => {
  const features = [["cross-origin-isolated", "crossOriginIsolated"], ["indexeddb", "indexedDB"], ["jspi", "jspi"], ["web-locks", "webLocks"]] as const;
  const none = { crossOriginIsolated: false, indexedDB: false, jspi: false, webLocks: false };
  const unused = { stat: () => Promise.reject(new Error("unused")) };
  for (const [feature, flag] of features) {
    const manifest = await manifestWith({ browser: [feature] });
    expect(await missingPrerequisites(manifest, { ...none, [flag]: true }, unused), `${feature} present`).toEqual([]);
    for (const [, other] of features) {
      if (other !== flag) expect(await missingPrerequisites(manifest, { ...none, [other]: true }, unused), `${feature} with only ${other}`).toEqual([`browser feature ${feature}`]);
    }
  }
});
