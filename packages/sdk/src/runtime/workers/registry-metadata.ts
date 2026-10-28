import { VMError } from "../errors.js";

type Scope = "root" | "versions" | "version" | "dist" | "other";
interface Frame {
  readonly object: boolean;
  readonly scope: Scope;
  /** This container's value is blanked: nothing inside it is emitted. */
  readonly discard: boolean;
  /** Under a frozen set: this container belongs to a locked version (or to
   * the document root); an unlocked version keeps only its trust evidence. */
  readonly locked: boolean;
  key: string;
  /** The version key last read in the `versions` object, for the frame below. */
  version: string;
  keyNext: boolean;
  /** The value that follows the current key is blanked in place. */
  blank: boolean;
}

/** The virtual registry serves the shape pnpm installs from: pnpm's own
 * condensed packument (`clearMeta` in its npm resolver) keeps these root and
 * version fields, and never reads signatures. Every other value is blanked in
 * place (`""`, `{}` or `[]`) so the document keeps its keys and structure while
 * the guest stops receiving and parsing readmes, maintainers, scripts and the
 * dev dependencies of packages it never installs. `dist.attestations` and
 * `_npmUser` stay: pnpm 11's trust policy reads their provenance, approver and
 * trusted-publisher evidence for every version.
 *
 * Under a frozen lockfile pnpm resolves nothing and its supply-chain checks
 * read, per package, the locked versions' manifests and publish times plus
 * every other version's publish time and trust evidence. A frozen set of
 * locked versions therefore blanks everything else of an unlocked version
 * (`next` has thousands of versions and 25 MB of them), and blanks the root
 * `etag` so pnpm never revalidates a pruned document from its metadata cache. */
const ROOT_FIELDS = new Set(["name", "dist-tags", "versions", "time", "modified", "etag"]);
const VERSION_FIELDS = new Set(["name", "version", "bin", "directories", "optionalDependencies", "dependencies",
  "peerDependencies", "peerDependenciesMeta", "dist", "engines", "cpu", "os", "libc", "deprecated", "bundleDependencies",
  "bundledDependencies", "hasInstallScript", "_npmUser"]);
const TRUST_VERSION_FIELDS = new Set(["_npmUser", "dist"]);
const DIST_BLANKED = new Set(["npm-signature", "signatures"]);

/** Lexical rewrite only: pnpm still parses metadata and selects packages. Keep
 * non-target bytes/lexemes, including numbers, intact without a metadata tree.
 * Caller reserves the working window and feeds at most 4 KiB per invocation. */
export class RegistryMetadata {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #encoder = new TextEncoder();
  readonly #frames: Frame[] = [];
  readonly #source: string;
  readonly #gateway: string;
  readonly #locked: ReadonlySet<string> | undefined;
  #string: "key" | "tarball" | "plain" | "discard" | undefined;
  #escaped = false;
  #token = "";
  #discarding = 0;
  #output = "";

  constructor(source: string, gateway: string, locked?: ReadonlySet<string>) {
    this.#source = source; this.#gateway = gateway; this.#locked = locked;
  }

  #blanked(frame: Frame, key: string): boolean {
    switch (frame.scope) {
      case "root": return !ROOT_FIELDS.has(key) || (key === "etag" && this.#locked !== undefined);
      case "version": return frame.locked ? !VERSION_FIELDS.has(key) : !TRUST_VERSION_FIELDS.has(key);
      case "dist": return frame.locked ? DIST_BLANKED.has(key) : key !== "attestations";
      case "versions": case "other": return false;
    }
  }

  write(bytes: Uint8Array, done = false): Uint8Array<ArrayBuffer> {
    if (bytes.byteLength > 4096) this.#invalid("Metadata input exceeds its frame bound");
    this.#output = "";
    let text: string;
    try { text = this.#decoder.decode(bytes, { stream: !done }); }
    catch { this.#invalid("Invalid registry metadata UTF-8"); }
    for (const character of text) {
      const frame = this.#frames.at(-1);
      if (this.#string !== undefined) { this.#inString(character, frame); continue; }
      if (character === '"') {
        if (frame?.object === true && frame.keyNext) { this.#string = "key"; this.#token = character; }
        else if (frame?.blank === true) { frame.blank = false; this.#string = "discard"; }
        else if (frame?.object === true && frame.scope === "dist" && frame.key === "tarball") { this.#string = "tarball"; this.#token = character; }
        else { this.#string = "plain"; this.#emit(character); }
        continue;
      }
      if (character === "{" || character === "[") {
        if (this.#frames.length >= 64) this.#invalid("Metadata nesting exceeds its bound");
        const discard = frame?.blank === true || this.#discarding !== 0;
        if (frame?.blank === true) frame.blank = false;
        const scope: Scope = discard || character !== "{" ? "other" : frame === undefined ? "root"
          : frame.scope === "root" && frame.key === "versions" ? "versions"
            : frame.scope === "versions" ? "version"
              : (frame.scope === "version" || frame.scope === "root") && frame.key === "dist" ? "dist" : "other";
        const locked = frame === undefined ? true
          : scope === "version" ? this.#locked === undefined || this.#locked.has(frame.version)
            : frame.locked;
        this.#frames.push({ object: character === "{", scope, discard, locked, key: "", version: "", keyNext: character === "{", blank: false });
        if (discard) { this.#discarding += 1; continue; }
      } else if (character === "}" || character === "]") {
        if (frame === undefined || frame.object !== (character === "}")) this.#invalid("Invalid metadata container");
        this.#frames.pop();
        if (frame.discard) {
          this.#discarding -= 1;
          if (this.#discarding === 0) this.#emit(character === "}" ? "{}" : "[]");
          continue;
        }
      } else if (character === ":" && frame?.object === true) frame.keyNext = false;
      else if (character === "," && frame !== undefined) { frame.keyNext = frame.object; frame.key = ""; frame.blank = false; }
      this.#emit(character);
    }
    if (done && (this.#frames.length !== 0 || this.#string !== undefined)) this.#invalid("Truncated registry metadata");
    return this.#encoder.encode(this.#output);
  }

  #inString(character: string, frame: Frame | undefined): void {
    if (this.#string === "plain") this.#emit(character);
    else if (this.#string !== "discard") {
      this.#token += character;
      if (this.#token.length > 4096) this.#invalid("Metadata key or tarball URL exceeds its bound");
    }
    if (this.#escaped) { this.#escaped = false; return; }
    if (character === "\\") { this.#escaped = true; return; }
    if (character !== '"') return;
    if (this.#string === "discard") this.#emit('""');
    else if (this.#string !== "plain") {
      let value: unknown;
      try { value = JSON.parse(this.#token); }
      catch { this.#invalid("Invalid registry metadata string"); }
      if (typeof value !== "string") this.#invalid("Invalid metadata string");
      if (this.#string === "key") {
        if (frame === undefined) this.#invalid("Metadata key has no object");
        frame.key = value === "versions" || value === "dist" || value === "tarball" ? value : "other";
        if (frame.scope === "versions") frame.version = value;
        frame.blank = !frame.discard && this.#discarding === 0 && this.#blanked(frame, value);
        this.#emit(this.#token);
      } else this.#emit(this.#tarball(value));
    }
    this.#string = undefined; this.#token = "";
  }

  #emit(text: string): void {
    if (this.#discarding === 0) this.#output += text;
  }

  #tarball(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { return this.#token; }
    if (url.origin !== this.#source || url.username !== "" || url.password !== "" || url.hash !== "") return this.#token;
    return JSON.stringify(this.#gateway + url.pathname + url.search);
  }

  #invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
}
