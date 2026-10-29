import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

function origin(): string {
  const value = process.env["OXIDEVM_STARTER_URL"];
  if (value === undefined) throw new Error("Set OXIDEVM_STARTER_URL to the staged pandas starter");
  return value;
}
test("real Linux pandas supports editing, CSV upload, export, persistence and interruption", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => { errors.push(error.message); });
  await page.goto(origin());
  await expect(page.getByRole("heading", { name: "Your data starter." })).toBeVisible();
  await expect(page.locator("#code-highlight .hljs-keyword").first()).toHaveText("import");
  await expect.poll(async () => page.locator("#error-message").textContent().then(error => error !== null && error.trim() !== "" ? error : page.locator("#shape").textContent()), { timeout: 180000 }).toBe("4 rows · 3 columns");
  await expect(page.locator("#binary")).toContainText("Real Linux executable · x86-64 · Python 3.12.15 · pandas 2.3.3");
  await expect(page.locator("#rows")).toContainText("Netherlands");
  const repeated = 'import os, pandas as pd\nassert "previous_run" not in globals()\nprevious_run = True\nprint("session-pid:" + str(os.getpid()))\nresult = pd.read_csv("data.csv").head(2)\n';
  const elapsed: number[] = [];
  let sessionPID = "";
  for (let iteration = 0; iteration < 2; iteration += 1) {
    await page.locator("#code").fill(repeated);
    const started = performance.now();
    await page.getByRole("button", { name: "Run code", exact: true }).click();
    await expect(page.locator("#state")).toHaveText("Ready", { timeout: 120000 });
    await expect(page.locator("#shape")).toHaveText("2 rows · 3 columns");
    const output = await page.locator("#output").textContent();
    expect(output).toMatch(/^session-pid:\d+\n$/u);
    if (iteration === 0) sessionPID = output ?? "";
    else expect(output).toBe(sessionPID);
    elapsed.push(performance.now() - started);
  }
  await info.attach("persistent-python-repeat-times", { body: JSON.stringify(elapsed), contentType: "application/json" });
  await page.locator("#code").fill((await import("../../examples/starter/src/analysis.js")).sampleCode);
  await page.locator("#file").setInputFiles({ name: "my-data.csv", mimeType: "text/csv", buffer: Buffer.from('name,value\nα,5\nβ,6\n"<img src=x onerror=alert(1)>",7\n') });
  await expect(page.locator("#shape")).toHaveText("3 rows · 2 columns", { timeout: 120000 });
  await expect(page.locator("#dataset")).toHaveText("From my-data.csv");
  expect(await page.locator("#code-highlight").textContent()).toBe((await page.locator("#code").inputValue()) + "\n");
  await expect(page.locator("#rows")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#rows img")).toHaveCount(0);
  if (process.env["OXIDEVM_STARTER_SMOKE"] === "1") return;
  const edited = 'import os, pandas as pd\nprint("session-pid:" + str(os.getpid()))\ndf = pd.read_csv("data.csv")\nprint("real-python-output")\nresult = df.assign(double=df["value"] * 2)\n';
  await page.locator("#code").fill(edited); await page.getByRole("button", { name: "Run code", exact: true }).click();
  await expect(page.locator("#shape")).toHaveText("3 rows · 3 columns", { timeout: 120000 });
  await expect(page.locator("#rows")).toContainText("14");
  await expect(page.locator("#output")).toContainText("real-python-output");
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "Export CSV" }).click();
  const downloaded = await downloading, path = await downloaded.path();
  expect(await readFile(path, "utf8")).toContain("name,value,double");
  await page.locator("#code").fill("raise ValueError('directed-python-error')"); await page.getByRole("button", { name: "Run code", exact: true }).click();
  await expect(page.locator("#error-message")).toContainText("directed-python-error", { timeout: 120000 });
  await expect(page.locator("#rows")).toContainText("14");
  await page.locator("#code").fill(edited); await page.getByRole("button", { name: "Run code", exact: true }).click();
  await expect(page.locator("#state")).toHaveText("Ready", { timeout: 120000 });
  await expect(page.locator("#output")).toContainText(sessionPID.trim());
  await page.locator("#code").fill("import time\ntime.sleep(60)"); await page.getByRole("button", { name: "Run code", exact: true }).click();
  await page.getByRole("button", { name: "Stop execution" }).click();
  await expect(page.locator("#state")).toHaveText("Ready", { timeout: 15000 });
  await page.locator("#code").fill(edited); await page.getByRole("button", { name: "Run code", exact: true }).click();
  await expect(page.locator("#shape")).toHaveText("3 rows · 3 columns", { timeout: 120000 });
  await page.reload();
  await expect(page.locator("#shape")).toHaveText("3 rows · 3 columns", { timeout: 180000 });
  await expect(page.locator("#code")).toHaveValue(edited); await expect(page.locator("#dataset")).toHaveText("From my-data.csv");
  await page.locator(".terminal-panel").hover();
  await page.getByRole("button", { name: "Focus terminal" }).click();
  await page.keyboard.type("python3 -c 'import numpy._core._multiarray_umath as n,pandas._libs.hashtable as p; assert all(open(m.__file__, \"rb\").read(4)==bytes([127,69,76,70]) for m in (n,p)); print(\"native-linux-\"+\"extensions-ok\")'\n");
  await expect.poll(() => page.locator("#terminal .xterm-accessibility-tree").textContent(), { timeout: 120000 }).toContain("native-linux-extensions-ok");
  await page.getByRole("button", { name: "Reset demo", exact: true }).first().click();
  await page.getByRole("button", { name: "Keep my changes" }).click(); await expect(page.locator("#rows")).toContainText("14");
  await page.getByRole("button", { name: "Reset demo", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset demo", exact: true }).click();
  await expect(page.locator("#shape")).toHaveText("4 rows · 3 columns", { timeout: 120000 });
  expect(await page.locator("#code-highlight").textContent()).toBe((await page.locator("#code").inputValue()) + "\n");
  await page.screenshot({ path: info.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a tampered signed image cannot start Python", async ({ context, page }) => {
  await context.route(/https:\/\/cdn\.oxidevm\.dev\/images\/oxidevm-starter-pandas\/[^/]+\/[a-f0-9]{64}\/manifest\.json/u, route => route.fulfill({ status: 200, contentType: "application/json", body: '{"tampered":true}' }));
  await page.goto(origin());
  await expect(page.locator("#error")).toBeVisible({ timeout: 120000 });
  await expect(page.locator("#rows tr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run code", exact: true })).toBeDisabled();
});
