import { expect, it } from "vitest";
import { parseArguments } from "./arguments.js";

it("creates the prebuilt starter with the short npx or bunx command", () => {
  expect(parseArguments(["init", "app", "--start"], {})).toMatchObject({ command: "init", mode: "userspace", start: true, packageManager: "npm" });
  expect(parseArguments(["init", "app", "--use-bun", "--start"], {})).toMatchObject({ command: "init", mode: "userspace", packageManager: "bun" });
});

it("accepts private starter archives and an explicit package manager without a public registry", () => {
  expect(parseArguments(["init", "app", "--mode", "userspace", "--start", "--use-bun", "--sdk-archive", "sdk.tgz", "--cli-archive", "cli.tgz"], {})).toMatchObject({ start: true, packageManager: "bun", archives: { sdk: "sdk.tgz", cli: "cli.tgz" } });
  for (const flags of [["--sdk-archive", "sdk.tgz"], ["--cli-archive", "cli.tgz"], ["--start", "--skip-assets"], ["--start", "--json"]]) {
    expect(() => parseArguments(["init", "app", "--mode", "userspace", ...flags], {})).toThrow();
  }
});

it("requires explicit trust when authoring legacy delivery packs", () => {
  expect(parseArguments(["image", "pack", "dist", "--trust", "author.json", "--json"], {})).toMatchObject({ command: "image pack", bundle: "dist", trust: "author.json", json: true });
  expect(() => parseArguments(["image", "pack", "dist"], {})).toThrow();
});
it("accepts a supplied image and requires its trust file during application initialization", () => {
  expect(parseArguments(["init", "app", "--mode", "userspace", "--image", "minimal", "--image-trust", "author.json", "--skip-assets"], {})).toMatchObject({ command: "init", image: { bundle: "minimal", trust: "author.json" } });
  expect(() => parseArguments(["init", "app", "--mode", "userspace", "--image", "minimal"], {})).toThrow();
  expect(() => parseArguments(["init", "app", "--mode", "userspace", "--image-trust", "author.json"], {})).toThrow();
  expect(parseArguments(["assets", "install", "--image", "minimal", "--trust", "author.json"], {})).toMatchObject({ command: "assets install", image: "minimal", trust: "author.json" });
});
it("accepts every exact command and rejects unknown, repeated, missing and contradictory input", () => {
  const commands = [
    ["init", "app", "--mode", "userspace", "--skip-assets"], ["assets", "install"], ["doctor"],
    ["image", "init", "python", "--mode", "system"], ["image", "keygen", "--out", "author.pem"],
    ["image", "build", "image.ts", "--signing-key", "author.pem"], ["image", "test", "dist", "--trust", "public.json"], ["image", "inspect", "dist"],
  ];
  for (const command of commands) expect(parseArguments(["--json", ...command], {}).kind).toBe("command");
  for (const command of [[], ["init", "app", "--mode", "auto"], ["image", "build", "x"], ["image", "test", "x"], ["doctor", "--out", "x"], ["image", "inspect", "x", "--trust", "a", "--trust", "b"], ["image", "build", "x", "--force"], ["init", "app", "extra", "--mode", "userspace"]]) expect(() => parseArguments(command, {})).toThrow();
  expect(parseArguments(["image", "build", "image.ts"], { OXIDEVM_SIGNING_KEY_FILE: "configured.pem" })).toMatchObject({ kind: "command", command: "image build", signingKey: "configured.pem" });
});
it("accepts --engine-dir only where the pinned engine release is staged or served", () => {
  expect(parseArguments(["assets", "install", "--engine-dir", "release"], {})).toMatchObject({ command: "assets install", engineDir: "release" });
  expect(parseArguments(["init", "app", "--mode", "userspace", "--engine-dir", "release"], {})).toMatchObject({ command: "init", engineDir: "release", skipAssets: false });
  expect(parseArguments(["image", "test", "dist", "--trust", "public.json", "--engine-dir", "release"], {})).toMatchObject({ command: "image test", engineDir: "release" });
  expect(parseArguments(["assets", "install"], {})).not.toHaveProperty("engineDir");
  for (const command of [["init", "app", "--mode", "userspace", "--skip-assets", "--engine-dir", "release"], ["doctor", "--engine-dir", "release"], ["image", "inspect", "dist", "--engine-dir", "release"], ["assets", "install", "--engine-dir", ""], ["assets", "install", "--engine-dir", "a", "--engine-dir", "b"]]) {
    let failure: unknown;
    try { parseArguments(command, {}); } catch (error: unknown) { failure = error; }
    expect(failure).toMatchObject({ code: "INVALID_ARGUMENT" });
  }
});
