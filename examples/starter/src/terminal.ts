import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { VM, TerminalHandle } from "@oxidevm/sdk";

export class TerminalView {
  readonly #terminal = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: "'JetBrains Mono', monospace", screenReaderMode: true, theme: { background: "#06142e", foreground: "#edf3ff", cursor: "#ff7a59", selectionBackground: "#0842c8" } });
  readonly #fit = new FitAddon();
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #resize: ResizeObserver;
  readonly #output: Promise<void>;
  #writes: Promise<void> = Promise.resolve();
  #sizes: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(readonly handle: TerminalHandle, readonly container: HTMLElement, failed: (error: unknown) => void) {
    this.#writer = handle.stdin.getWriter(); this.#reader = handle.output.getReader();
    this.#terminal.loadAddon(this.#fit); this.#terminal.open(container); this.#fit.fit();
    this.#terminal.onData(text => { if (!this.#closed) this.write(text, failed); });
    this.#resize = new ResizeObserver(() => {
      if (this.#closed || container.clientWidth === 0 || container.clientHeight === 0) return;
      this.#fit.fit(); this.#sizes = this.#sizes.then(() => handle.resize({ columns: this.#terminal.cols, rows: this.#terminal.rows })).catch(failed);
    });
    this.#resize.observe(container);
    this.#output = this.#drain().catch(failed);
    void handle.exit.then(exit => { if (!this.#closed) this.#terminal.writeln(`\r\n[${exit.kind === "exited" ? `Exited ${String(exit.code)}` : `Signal ${exit.signal ?? String(exit.signalNumber)}`}]`); }).catch(failed);
  }
  static async open(vm: VM, container: HTMLElement, failed: (error: unknown) => void): Promise<TerminalView> {
    const handle = await vm.spawn({ command: "/bin/sh", args: ["-c", "printf '$ uname -m\\n'; uname -m; printf '$ command -v python3\\n'; command -v python3; if [ -x /bin/mksh ]; then export SHELL=/bin/mksh; exec /bin/mksh -i; else exec /bin/sh -i; fi"], terminal: { columns: 80, rows: 8 }, env: { HOME: "/workspace", PATH: "/usr/sbin:/usr/bin:/bin", TERM: "xterm-256color", PS1: "$ " } });
    return new TerminalView(handle, container, failed);
  }
  write(text: string, failed: (error: unknown) => void): void {
    if (this.#closed) return;
    this.#writes = this.#writes.then(() => this.#writer.write(new TextEncoder().encode(text))).catch(failed);
  }
  focus(): void { this.#terminal.focus(); }
  async #drain(): Promise<void> {
    try { for (;;) { const next = await this.#reader.read(); if (next.done) return; await new Promise<void>(complete => this.#terminal.write(next.value, complete)); } }
    finally { this.#reader.releaseLock(); }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; this.#resize.disconnect();
    try { await this.#writes; await this.#sizes; await this.handle.kill("SIGKILL", { scope: "process-group" }); await this.handle.exit; await this.#output; }
    finally { this.#writer.releaseLock(); this.#terminal.dispose(); this.container.replaceChildren(); }
  }
}
