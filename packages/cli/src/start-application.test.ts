import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startApplication } from "./start-application.js";

it("cleans up its package-manager process group when startup is canceled", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-start-"));
  const controller = new AbortController();
  try {
    await writeFile(join(root, "npm"), `#!${process.execPath}\nprocess.stdout.write('child-ready\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    await expect(startApplication(root, "npm", { directory: root, environment: { PATH: root }, signal: controller.signal, stdout: text => { if (text.includes("child-ready")) controller.abort(); }, stderr: () => undefined })).rejects.toMatchObject({ code: "ABORTED" });
    const stopped = new AbortController(); stopped.abort();
    await expect(startApplication(root, "npm", { directory: root, environment: {}, signal: stopped.signal, stdout: () => undefined, stderr: () => undefined })).rejects.toMatchObject({ code: "ABORTED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
