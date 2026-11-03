import { NetError } from "./errors.js";

/**
 * The most trust entries one TLS session takes. The engine's `MAX_EXTRA_ANCHORS` caps the certificates they hold at the
 * same number, and every entry holds at least one, so a full public root bundle (about 150 certificates) plus custom
 * roots fits.
 */
export const MAX_TRUST_ANCHORS = 512;
/** The most bytes of extra trust anchors one TLS session takes (the engine's `MAX_EXTRA_ANCHOR_BYTES`). */
export const MAX_TRUST_BYTES = 2 * 1024 * 1024;

const PEM_MARKER = "-----";
const CERTIFICATE_END = "-----END CERTIFICATE-----";

/**
 * A session's extra trust anchors from untrusted module code: an array of byte arrays, each a PEM bundle or one DER
 * certificate (a CA file, as `SSLContext.load_verify_locations` reads it). They only add trust; the engine parses them.
 * Anything else, too many or too large is ERR_TLS_INVALID_TRUST. The bytes are copied, so later changes cannot reach
 * the session.
 */
export function decodeTrust(value: unknown): readonly Uint8Array[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("trust must be an array of Uint8Array");
  const entries: unknown[] = value;
  if (entries.length > MAX_TRUST_ANCHORS) throw invalid(`trust holds at most ${String(MAX_TRUST_ANCHORS)} entries`);
  let total = 0;
  return Object.freeze(entries.map(entry => {
    if (!(entry instanceof Uint8Array) || entry.length === 0) throw invalid("each trust entry must be a non-empty Uint8Array (PEM or DER)");
    total += entry.length;
    if (total > MAX_TRUST_BYTES) throw invalid(`trust holds at most ${String(MAX_TRUST_BYTES)} bytes`);
    return entry.slice();
  }));
}

/**
 * One decoded trust entry as the engine's appends take it, each at most `capacity` bytes (the TLS exchange buffer): the
 * entry itself when it fits, otherwise a PEM bundle cut right after its certificate blocks (certifi's bundle is larger
 * than the buffer). Every chunk then holds whole certificates, and text after the last one without a PEM marker, which
 * the engine skips, is dropped. A DER certificate or one PEM block larger than the buffer is ERR_TLS_INVALID_TRUST.
 */
export function trustChunks(entry: Uint8Array, capacity: number): readonly Uint8Array[] {
  if (entry.length <= capacity) return [entry];
  // windows-1252 maps every byte to one UTF-16 unit, so string offsets are byte offsets.
  const text = new TextDecoder("latin1").decode(entry);
  if (!text.includes(PEM_MARKER)) throw invalid("a DER trust entry is larger than the TLS exchange buffer");
  const chunks: Uint8Array[] = [];
  let start = 0, cut = 0;
  for (const end of certificateEnds(text)) {
    if (end - start > capacity) {
      if (cut === start) throw invalid("a PEM block in a trust entry is larger than the TLS exchange buffer");
      chunks.push(entry.subarray(start, cut));
      start = cut;
      if (end - start > capacity) throw invalid("a PEM block in a trust entry is larger than the TLS exchange buffer");
    }
    cut = end;
  }
  if (!text.includes(PEM_MARKER, cut)) {
    if (cut > start) chunks.push(entry.subarray(start, cut));
  } else if (entry.length - start <= capacity) {
    chunks.push(entry.subarray(start));
  } else {
    if (cut > start) chunks.push(entry.subarray(start, cut));
    if (entry.length - cut > capacity) throw invalid("a PEM block in a trust entry is larger than the TLS exchange buffer");
    chunks.push(entry.subarray(cut));
  }
  return chunks;
}

/** The offsets just past each `-----END CERTIFICATE-----` line and its line ending. */
function certificateEnds(text: string): number[] {
  const ends: number[] = [];
  for (let at = text.indexOf(CERTIFICATE_END); at !== -1; at = text.indexOf(CERTIFICATE_END, at)) {
    at += CERTIFICATE_END.length;
    if (text[at] === "\r") at += 1;
    if (text[at] === "\n") at += 1;
    ends.push(at);
  }
  return ends;
}

function invalid(message: string): NetError { return new NetError("ERR_TLS_INVALID_TRUST", `TLS: ${message}`, { syscall: "tls" }); }
