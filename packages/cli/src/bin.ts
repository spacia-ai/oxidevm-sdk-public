#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCLI } from "./run.js";

/** One yes-or-no question on the terminal; anything but y or yes is no, and an interrupt is no. */
async function ask(question: string, signal: AbortSignal): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/iu.test((await lines.question(question, { signal })).trim()); }
  catch { return false; }
  finally { lines.close(); }
}

const controller = new AbortController();
const interrupt = () => { controller.abort({kind:"signal",signal:"SIGINT"}); };
const terminate = () => { controller.abort({kind:"signal",signal:"SIGTERM"}); };
process.on("SIGINT", interrupt);
process.on("SIGTERM",terminate);
try {
  process.exitCode = await runCLI(process.argv.slice(2), { directory: process.cwd(), environment: process.env, signal: controller.signal,
    stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
    ...(process.stdin.isTTY && process.stderr.isTTY ? { confirm: question => ask(question, controller.signal) } : {}) });
} finally { process.off("SIGINT", interrupt);process.off("SIGTERM",terminate); }
