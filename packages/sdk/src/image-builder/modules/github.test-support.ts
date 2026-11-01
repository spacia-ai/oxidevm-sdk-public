import type { Route } from "./fetch.test-support.js";
import { fakeNetwork } from "./fetch.test-support.js";
import type { BuiltRelease } from "./release.test-support.js";
import { sha } from "./release.test-support.js";

export interface StubOptions {
  readonly owner?: string;
  readonly repo?: string;
  readonly tag?: string;
  readonly draft?: boolean;
  /** GitHub's `immutable` flag on the release; absent means the field is not reported. */
  readonly immutable?: boolean;
  readonly commit?: string;
  readonly attestations?: "present" | "empty" | 404 | 500;
  /** Names of release files to leave out of the asset list. */
  readonly without?: readonly string[];
  /** Replaces the bytes served for a file after its pin was computed, to model tampering. */
  readonly tamper?: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
  /** Replaces the digest GitHub reports for an asset. */
  readonly digest?: Readonly<Record<string, string>>;
  /** Replaces the size GitHub reports for an asset. */
  readonly size?: Readonly<Record<string, number>>;
  readonly state?: string;
  /** Where the asset redirect points. */
  readonly storage?: string;
}

/** A fake GitHub API for one repository and one release, plus the storage host its asset URLs redirect to. */
export function githubStub(release: BuiltRelease, options: StubOptions = {}) {
  const owner = options.owner ?? "acme", repo = options.repo ?? "tool-module", tag = options.tag ?? "v1.0.0";
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const names = [...release.files.keys()].filter(name => !(options.without ?? []).includes(name));
  const ids = new Map(names.map((name, index) => [name, 100 + index]));
  const storage = options.storage ?? "https://objects.githubusercontent.com/blob";
  const routes: Record<string, Route> = {
    [`${base}/releases/tags/${tag}`]: { body: JSON.stringify({
      draft: options.draft ?? false, ...(options.immutable === undefined ? {} : { immutable: options.immutable }),
      assets: names.map(name => {
        const bytes = release.files.get(name);
        return { name, id: ids.get(name), size: options.size?.[name] ?? bytes?.byteLength ?? 0, state: options.state ?? "uploaded", digest: options.digest?.[name] ?? `sha256:${sha(bytes ?? new Uint8Array())}` };
      }),
    }) },
    [`${base}/commits/${tag}`]: { body: options.commit ?? "c".repeat(40) },
  };
  for (const [name, id] of ids) {
    routes[`${base}/releases/assets/${String(id)}`] = { status: 302, headers: { location: `${storage}/${String(id)}` } };
    routes[`${storage}/${String(id)}`] = { body: options.tamper?.[name] ?? release.files.get(name) ?? new Uint8Array() };
  }
  const id = sha(release.sumsBytes);
  routes[`${base}/attestations/sha256:${id}`] = options.attestations === "present" || options.attestations === undefined ? { body: JSON.stringify({ attestations: [{ bundle: {} }] }) }
    : options.attestations === "empty" ? { body: JSON.stringify({ attestations: [] }) } : { status: options.attestations };
  return { ...fakeNetwork(routes), base, tag, ids };
}
