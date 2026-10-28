/** Framed stdio used by the fixed Node helper programs. Each consumer defines
 * protocol() and MAX_DATA/MAX_CONTROL, then validates its own control records. */
export const nativeGuestFrames = String.raw`
async function* frames() {
  const header = Buffer.alloc(5); let used = 0; let payload; let filled = 0;
  for await (const chunk of process.stdin) {
    let offset = 0;
    while (offset < chunk.length) {
      if (used < 5) {
        const count = Math.min(5 - used, chunk.length - offset);
        chunk.copy(header, used, offset, offset + count); offset += count; used += count;
        if (used !== 5) continue;
        const size = header.readUInt32BE(1);
        if ((header[0] !== 0 && header[0] !== 1) || size === 0 || size > (header[0] === 0 ? MAX_DATA : MAX_CONTROL)) throw protocol();
        payload = Buffer.allocUnsafe(size); filled = 0;
      }
      const count = Math.min(payload.length - filled, chunk.length - offset);
      chunk.copy(payload, filled, offset, offset + count); offset += count; filled += count;
      if (filled === payload.length) { yield [header[0], payload]; used = 0; payload = undefined; }
    }
  }
  if (used !== 0) throw protocol();
}
function send(tag, payload) {
  if (payload.length > (tag === 0 ? MAX_DATA : MAX_CONTROL)) return Promise.reject(protocol());
  const frame = Buffer.allocUnsafe(payload.length + 5); frame[0] = tag;
  frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
  return new Promise((resolve, reject) => (tag === 0 ? process.stdout : process.stderr).write(frame, error => error ? reject(error) : resolve()));
}
`;

export function nativeGuestArguments(source: string, options: Readonly<Record<string, unknown>>): string[] {
  const input = JSON.stringify({ source, options: JSON.stringify(options) });
  const parts: string[] = []; let part = "";
  for (const character of input) {
    part += character;
    if (part.length >= 512) { parts.push(part); part = ""; }
  }
  if (part.length !== 0) parts.push(part);
  return ["--no-warnings", "-e", "const input=JSON.parse(process.argv.slice(1).join(''));process.argv=[process.execPath,input.options];eval(input.source)", ...parts];
}
