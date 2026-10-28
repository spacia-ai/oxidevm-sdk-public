#!/usr/bin/env node
import { runCLI } from "./run.js";

const controller = new AbortController();
const interrupt = () => { controller.abort({kind:"signal",signal:"SIGINT"}); };
const terminate = () => { controller.abort({kind:"signal",signal:"SIGTERM"}); };
process.on("SIGINT", interrupt);
process.on("SIGTERM",terminate);
try {
  process.exitCode = await runCLI(process.argv.slice(2), { directory: process.cwd(), environment: process.env, signal: controller.signal,
    stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } });
} finally { process.off("SIGINT", interrupt);process.off("SIGTERM",terminate); }
