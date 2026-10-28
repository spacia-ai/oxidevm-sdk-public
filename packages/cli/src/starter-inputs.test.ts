import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readStarterInputs } from "./starter-inputs.js";

it("selects the prebuilt private starter without exposing operator paths as CLI arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-starter-inputs-"));
  try {
    expect(await readStarterInputs(root, "0.0.1")).toBeUndefined();
    await mkdir(join(root, ".oxidevm"));
    const profile = { schemaVersion: 1, sdkVersion: "0.0.1", image: { bundle: "../image", trust: "../author.public.json" }, engineDir: "../engine", archives: { sdk: "../sdk.tgz", cli: "../cli.tgz" } };
    const path = join(root, ".oxidevm/starter.json");
    await writeFile(path, JSON.stringify(profile));
    expect(await readStarterInputs(root, "0.0.1")).toEqual({ image: { bundle: join(root, "image"), trust: join(root, "author.public.json") }, engineDir: join(root, "engine"), archives: { sdk: join(root, "sdk.tgz"), cli: join(root, "cli.tgz") } });
    await expect(readStarterInputs(root, "0.0.2")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await writeFile(path, JSON.stringify({ ...profile, extra: "unexpected" }));
    await expect(readStarterInputs(root, "0.0.1")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
