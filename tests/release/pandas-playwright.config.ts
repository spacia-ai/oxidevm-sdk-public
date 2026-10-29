import { defineConfig } from "@playwright/test";

const input: unknown = JSON.parse(process.env["OXIDEVM_TEST_BROWSER_ARGS"] ?? "[]");
if (!Array.isArray(input) || input.length > 16 || !Array.from<unknown>(input).every(value => typeof value === "string" && value.length <= 8192)) throw new Error("Invalid private browser fixture arguments");
const args = Array.from<unknown>(input).map(value => { if (typeof value !== "string") throw new Error("Invalid browser argument"); return value; });

export default defineConfig({
  testDir: import.meta.dirname, testMatch: "pandas-starter.spec.ts", workers: 1, retries: 0,
  timeout: 300_000, reporter: "list", outputDir: "../../.cache/starter-browser",
  use: { browserName: "chromium", headless: true, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", launchOptions: { args } },
});
