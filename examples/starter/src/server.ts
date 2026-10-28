import type { ProcessHandle, VM } from "@oxidevm/sdk";

export const nginxConfig = `daemon off;
master_process off;
pid /tmp/oxidevm-nginx.pid;
error_log stderr warn;
events { worker_connections 64; }
http {
  log_format demo escape=json '{"status":$status,"path":"$uri"}';
  access_log /workspace/nginx-access.log demo;
  client_body_temp_path /tmp/client_body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server {
    listen 8080;
    root /workspace/site;
    index index.html;
    default_type text/html;
    types { text/html html; font/woff2 woff2; }
    add_header Cache-Control "no-store" always;
  }
}
`;

export function verifyExecutable(bytes: Uint8Array): void {
  if (bytes.length < 64 || bytes[0] !== 127 || bytes[1] !== 69 || bytes[2] !== 76 || bytes[3] !== 70 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || bytes[18] !== 62 || bytes[19] !== 0) {
    throw new Error("The starter requires a Linux x86-64 ELF at /usr/sbin/nginx.");
  }
}

export function decodeAccessLine(line: string): { readonly status: number; readonly path: string } | null {
  if (line.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2 || !("status" in value) || !("path" in value)) return null;
    if (typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 100 || value.status > 599 || typeof value.path !== "string" || value.path.length > 2048) return null;
    return { status: value.status, path: value.path };
  } catch { return null; }
}

async function readLines(stream: ReadableStream<Uint8Array>, receive: (line: string) => void): Promise<void> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let pending = "", dropping = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (const part of text.split(/(?<=\n)/u)) {
        if (!dropping) pending += part;
        if (pending.length > 4096) { pending = ""; dropping = true; }
        if (part.endsWith("\n")) { if (!dropping) receive(pending.trimEnd()); pending = ""; dropping = false; }
      }
      if (chunk.done) { if (!dropping && pending !== "") receive(pending); return; }
    }
  } finally { reader.releaseLock(); }
}

export async function startServer(vm: VM, receive: (line: string | null) => void, signal: AbortSignal) {
  await vm.workspace.writeText("nginx.conf", nginxConfig, signal);
  await vm.workspace.writeText("nginx-access.log", "", signal);
  const lifetime = new AbortController();
  let reading = false, dirty = false;
  async function access(): Promise<void> {
    dirty = true;
    if (reading) return;
    reading = true;
    try {
      while (dirty && !lifetime.signal.aborted) {
        dirty = false;
        const file = await vm.workspace.read("nginx-access.log", { maxBytes: 65536, signal: lifetime.signal });
        const last = new TextDecoder().decode(file.data).trimEnd().split("\n").findLast(line => decodeAccessLine(line)?.path === "/index.html");
        if (last !== undefined && last !== "") receive(last);
      }
    } catch { if (!lifetime.signal.aborted) receive(null); }
    finally { reading = false; }
  }
  const watch = vm.workspace.watch(changes => {
    if (changes.some(change => change.kind === "rescan" || change.name === "nginx-access.log")) void access();
  }, { signal: lifetime.signal });
  void watch.done.catch(() => { if (!lifetime.signal.aborted) receive(null); });
  try { await watch.setDirectories(["/"]); }
  catch (error) { lifetime.abort(); throw error; }
  let process: ProcessHandle;
  try { process = await vm.spawn({ command: "/usr/sbin/nginx", args: ["-e", "stderr", "-p", "/workspace/", "-c", "/workspace/nginx.conf"], cwd: "/workspace", signal }); }
  catch (error) { lifetime.abort(); throw error; }
  let diagnostic = "";
  const output = Promise.all([readLines(process.stdout, receive), readLines(process.stderr, line => { diagnostic = `${diagnostic}\n${line}`.slice(-4096); receive(line); })]);
  // Observe drains immediately; their failures must not become unhandled rejections.
  void output.catch(() => undefined);
  try {
    const preview = await Promise.race([
      vm.exposePort(8080, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }),
      process.exit.then(async exit => { await output; throw new Error(`nginx exited before listening (${exit.kind === "exited" ? String(exit.code) : "signal"}).${diagnostic}`); }),
    ]);
    return {
      preview, exit: process.exit.finally(() => { lifetime.abort(); }),
      async stop(): Promise<void> {
        lifetime.abort();
        await preview.close();
        await process.kill("SIGTERM");
        await process.exit;
        await output;
      },
    };
  } catch (error) {
    lifetime.abort();
    await process.kill("SIGKILL").catch(() => undefined);
    await output.catch(() => undefined);
    throw error;
  }
}
