import { defineConfig } from "@playwright/test";
import { isAbsolute, join } from "node:path";

const input: unknown = JSON.parse(process.env["OXIDEVM_TEST_BROWSER_ARGS"] ?? "[]");
if (!Array.isArray(input) || input.length > 16 || !Array.from<unknown>(input).every(value => typeof value === "string" && value.length <= 8192)) throw new Error("Invalid private browser fixture arguments");
const args = Array.from<unknown>(input).map(value => { if (typeof value !== "string") throw new Error("Invalid browser argument"); return value; });
// Playwright restarts its worker, and so the browser, after a failed test: one net-log per worker process keeps the failed browser's log.
const netLogs = process.env["OXIDEVM_TEST_NETLOG_DIR"];
if (netLogs !== undefined && (!isAbsolute(netLogs) || netLogs.length > 4096)) throw new Error("Invalid browser net-log directory");
const diagnostics = netLogs === undefined ? [] : [`--log-net-log=${join(netLogs, `chromium-${String(process.pid)}.json`)}`, "--net-log-capture-mode=Default"];

export default defineConfig({
  testDir: import.meta.dirname, testMatch: "pandas-starter.spec.ts", workers: 1, retries: 0,
  timeout: 300_000, reporter: "list", outputDir: "../../.cache/starter-browser",
  use: { browserName: "chromium", headless: true, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions: { args: [...args, ...diagnostics] } },
});
