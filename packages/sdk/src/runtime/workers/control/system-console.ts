import { TextDecoder, TextEncoder } from "../../web-encoding.js";
import { assertStatus, callNumber, type Core } from "./core.js";

/** Delivery consumes the boot queue; diagnostics retain a separate bounded tail
 * across live delivery and failure, until the machine is replaced. */
export class SystemConsole {
  #boot = new Uint8Array();
  #tail = new Uint8Array();

  resize(core: Core, size: { readonly columns: number; readonly rows: number }): void {
    assertStatus(callNumber(core, "oxidevm_system_console_resize", [size.columns, size.rows]));
  }

  record(bytes: Uint8Array): void {
    this.#tail = append(this.#tail, bytes, 64 * 1024);
  }
  queueBoot(bytes: Uint8Array): void {
    this.#boot = append(this.#boot, bytes, 1024 * 1024);
  }
  takeBoot(): Uint8Array<ArrayBuffer> {
    const bytes = this.#boot;
    this.#boot = new Uint8Array();
    return bytes;
  }
  /** The newest 64 KiB of console output as the guest wrote it. */
  tailBytes(): Uint8Array<ArrayBuffer> {
    return this.#tail.slice();
  }
  tail(): string {
    const decoder = new TextDecoder();
    const text = decoder.decode(this.#tail);
    // Invalid guest bytes expand to UTF-8 replacement characters. Bound the
    // encoded diagnostic field too, and never cut inside a replacement/codepoint.
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= 64 * 1024) return text;
    let start = bytes.byteLength - 64 * 1024;
    while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    return decoder.decode(bytes.subarray(start));
  }
  reset(): void {
    this.#boot = new Uint8Array(); this.#tail = new Uint8Array();
  }
}

function append(previous: Uint8Array, bytes: Uint8Array, limit: number): Uint8Array<ArrayBuffer> {
  const length = Math.min(bytes.byteLength, limit);
  const retained = Math.min(previous.byteLength, limit - length);
  const result = new Uint8Array(retained + length);
  result.set(previous.subarray(previous.byteLength - retained));
  result.set(bytes.subarray(bytes.byteLength - length), retained);
  return result;
}
