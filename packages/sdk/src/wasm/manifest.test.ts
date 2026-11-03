import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VMError } from "../runtime/errors.js";
import { decodeDeclaration, decodeModuleManifest, decodeResolvedManifest, encodeModuleManifest, isServiceDecl, MAX_MANIFEST_BYTES } from "./manifest.js";
import { CAPABILITY_MIN_API, manifestMinApi } from "./capabilities.js";
import { moduleReach } from "./reach.js";

const sha = "a".repeat(64);
const command = {
  id: "md2html",
  version: "1.0.0",
  abi: "bindgen",
  artifacts: [{ name: "markdown.wasm", from: "pkg/markdown_bg.wasm" }],
  process: { kind: "command" },
  requires: { host: ["files.sync"] },
  license: { spdx: "MIT" },
};
const service = {
  id: "pglite",
  version: "1.0.0",
  abi: "emscripten",
  artifacts: [{ name: "pglite.wasm", from: "upstream/pglite.wasm" }, { name: "client.py", from: "guest/client.py" }, { name: "NOTICE", from: "NOTICE" }],
  process: { kind: "service", exclusive: "workspace" },
  expose: {
    sql: { kind: "unix", path: "/workspace/_oxidevm/pglite.sock", protocol: "oxidevm-sql/1" },
    pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" },
  },
  requires: { host: ["process.info", "files.sync", "files.async"], browser: ["web-locks", "indexeddb"], guest: { executables: ["/usr/bin/python3"] } },
  mounts: [{ guest: "/workspace", access: "rw", durability: "fsync" }],
  limits: { clients: 4, startupMs: 120000 },
  state: { durable: ["/workspace/pgdata"] },
  guestFiles: [{ artifact: "client.py", to: "/workspace/_oxidevm/py/oxidevm_pglite.py", mode: 0o644 }],
  options: {
    durability: { type: "enum", values: ["relaxed", "strict"], default: "strict" },
    dataDir: { type: "string", maxLength: 128, default: "/workspace/pgdata" },
  },
  license: { spdx: "Apache-2.0", notices: ["NOTICE"], source: "https://github.com/electric-sql/pglite" },
  upstream: [{ name: "@electric-sql/pglite", version: "0.5.14", source: "https://www.npmjs.com/package/@electric-sql/pglite" }],
};

function resolved<D extends { readonly artifacts: readonly { readonly name: string }[] }>(declaration: D) {
  return {
    ...declaration,
    schemaVersion: 1,
    adapter: { api: 1, sha256: sha, bytes: 1234 },
    artifacts: declaration.artifacts.map(artifact => ({ name: artifact.name, sha256: sha, bytes: 10 })),
  };
}

/** Expects the stable decode failure; with `message`, the failure's message must also match it. */
function expectInvalid(run: () => unknown, label: string, message?: RegExp): void {
  try {
    run();
  } catch (error: unknown) {
    expect(error, label).toBeInstanceOf(VMError);
    expect(error, label).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
    if (message !== undefined && error instanceof VMError) expect(error.message, label).toMatch(message);
    return;
  }
  throw new Error(`${label} was accepted`);
}

describe("module declarations", () => {
  it("decodes a command in canonical key order", () => {
    const decoded = decodeDeclaration(command);
    expect(Object.keys(decoded)).toEqual(["id", "version", "abi", "artifacts", "process", "requires", "license"]);
    expect(decoded.process).toEqual({ kind: "command" });
  });

  it("decodes a service with every optional block and sorts keyed records and sets", () => {
    const decoded = decodeDeclaration(service);
    expect(Object.keys(decoded)).toEqual(["id", "version", "abi", "artifacts", "process", "expose", "requires", "mounts", "limits", "state", "guestFiles", "options", "license", "upstream"]);
    if (!isServiceDecl(decoded)) throw new Error("expected a service");
    expect(Object.keys(decoded.expose)).toEqual(["pg", "sql"]);
    expect(decoded.requires.host).toEqual(["files.async", "files.sync", "process.info"]);
    expect(decoded.requires.browser).toEqual(["indexeddb", "web-locks"]);
    expect(Object.keys(decoded.options ?? {})).toEqual(["dataDir", "durability"]);
  });

  it("rejects every structural mistake with a typed error and one stable reason", () => {
    const cases: Readonly<Record<string, unknown>> = {
      "unknown key": { ...command, extra: true },
      "resolved-only key": { ...command, schemaVersion: 1 },
      "hash in a declaration": { ...command, artifacts: [{ name: "a.wasm", sha256: sha, bytes: 1 }] },
      "artifact without from": { ...command, artifacts: [{ name: "a.wasm" }] },
      "absolute from": { ...command, artifacts: [{ name: "a.wasm", from: "/etc/passwd" }] },
      "dot-dot from": { ...command, artifacts: [{ name: "a.wasm", from: "../a.wasm" }] },
      "duplicate artifacts": { ...command, artifacts: [{ name: "a.wasm", from: "a" }, { name: "a.wasm", from: "b" }] },
      "uppercase id": { ...command, id: "Md2html" },
      "short version": { ...command, version: "1.0" },
      "unknown abi": { ...command, abi: "wasm" },
      "service without expose": { ...service, expose: undefined },
      "command with expose": { ...command, expose: service.expose },
      "exclusive command": { ...command, process: { kind: "command", exclusive: "workspace" } },
      "command with clients": { ...command, limits: { clients: 2 } },
      "socket outside the module roots": { ...service, expose: { sql: { kind: "unix", path: "/etc/x.sock", protocol: "x/1" } } },
      "socket path too long": { ...service, expose: { sql: { kind: "unix", path: `/tmp/${"x".repeat(104)}`, protocol: "x/1" } } },
      "privileged port": { ...service, expose: { pg: { kind: "tcp", port: 80, protocol: "http/1.1" } } },
      "duplicate ports": { ...service, expose: { a: { kind: "tcp", port: 5432, protocol: "x/1" }, b: { kind: "tcp", port: 5432, protocol: "x/1" } } },
      "unknown capability": { ...command, requires: { host: ["files.syncc"] } },
      "unknown browser feature": { ...command, requires: { host: [], browser: ["webgpu"] } },
      "duplicate capability": { ...command, requires: { host: ["files.sync", "files.sync"] } },
      "guest file for an undeclared artifact": { ...service, guestFiles: [{ artifact: "missing.py", to: "/workspace/x.py" }] },
      "durable path outside a rw mount": { ...service, mounts: [{ guest: "/workspace", access: "ro" }] },
      "durable path with no mount": { ...service, mounts: undefined },
      "option default out of range": { ...command, options: { count: { type: "integer", min: 1, max: 3, default: 9 } } },
      "enum default not listed": { ...command, options: { mode: { type: "enum", values: ["a"], default: "b" } } },
      "enum-set default not listed": { ...command, options: { sets: { type: "enum-set", values: ["a"], default: ["a", "b"] } } },
      "option name with a dash": { ...command, options: { "data-dir": { type: "boolean" } } },
      "placeholder license": { ...command, license: { spdx: "NOASSERTION" } },
      "plain http license source": { ...command, license: { spdx: "MIT", source: "http://example.com" } },
      "notice that is not an artifact": { ...command, license: { spdx: "MIT", notices: ["NOTICE"] } },
      "duplicate notices": { ...service, license: { spdx: "MIT", notices: ["NOTICE", "NOTICE"] } },
      "notice path instead of a name": { ...service, license: { spdx: "MIT", notices: ["licenses/NOTICE"] } },
      ...Object.fromEntries([".", "..", "...", ".hidden", "a/b", "a\\b", "", "x".repeat(129), "module.json", "adapter.mjs", "SHA256SUMS"].map(name => [`artifact named ${JSON.stringify(name)}`, { ...command, artifacts: [{ name, from: "a.wasm" }] }])),
      "guest file for a reserved name": { ...command, artifacts: [{ name: "a.wasm", from: "a" }], guestFiles: [{ artifact: "adapter.mjs", to: "/workspace/x" }] },
      "plain http upstream": { ...command, upstream: [{ name: "x", version: "1", source: "http://example.com" }] },
    };
    for (const [label, value] of Object.entries(cases)) expectInvalid(() => decodeDeclaration(value), label);
  });
});

describe("resolved module.json", () => {
  it("applies the same artifact-name rules as a declaration", () => {
    for (const name of [".", "..", ".hidden", "a/b", "module.json", "adapter.mjs", "SHA256SUMS"]) {
      expectInvalid(() => decodeResolvedManifest({ ...resolved(command), artifacts: [{ name, sha256: sha, bytes: 1 }] }), `artifact ${name}`);
    }
    expectInvalid(() => decodeResolvedManifest({ ...resolved(service), license: { spdx: "MIT", notices: ["missing.txt"] } }), "notice without an artifact");
  });

  it("round-trips through the canonical byte form", () => {
    for (const declaration of [command, service]) {
      const manifest = decodeResolvedManifest(resolved(declaration));
      const bytes = encodeModuleManifest(manifest);
      expect(decodeModuleManifest(bytes)).toEqual(manifest);
      expect(new TextDecoder().decode(bytes).endsWith("}\n")).toBe(true);
      expect(Object.keys(manifest).slice(0, 5)).toEqual(["schemaVersion", "id", "version", "abi", "adapter"]);
    }
  });

  it("rejects bytes that are not canonical, even when they decode to the same value", () => {
    const manifest = decodeResolvedManifest(resolved(service));
    const text = new TextDecoder().decode(encodeModuleManifest(manifest));
    const encode = (value: string) => new TextEncoder().encode(value);
    const { schemaVersion, ...others } = manifest;
    const reordered = `${JSON.stringify({ ...others, schemaVersion }, null, 2)}\n`;
    const variants: Readonly<Record<string, Uint8Array>> = {
      "compact": encode(JSON.stringify(manifest)),
      "no final newline": encode(text.trimEnd()),
      "two final newlines": encode(`${text}\n`),
      "four-space indent": encode(`${JSON.stringify(manifest, null, 4)}\n`),
      "reordered keys": encode(reordered),
      "not JSON": encode("{"),
      "invalid UTF-8": new Uint8Array([0xff, 0xfe]),
      "oversize": new Uint8Array(MAX_MANIFEST_BYTES + 1),
    };
    for (const [label, bytes] of Object.entries(variants)) expectInvalid(() => decodeModuleManifest(bytes), label);
  });

  it("requires the schema version, the adapter pin and a hash for every artifact", () => {
    const base = resolved(command);
    const cases: Readonly<Record<string, unknown>> = {
      "schema 2": { ...base, schemaVersion: 2 },
      "adapter api 2": { ...base, adapter: { api: 2, sha256: sha, bytes: 1 } },
      "adapter without hash": { ...base, adapter: { api: 1, bytes: 1 } },
      "short hash": { ...base, artifacts: [{ name: "markdown.wasm", sha256: "abc", bytes: 1 }] },
      "negative size": { ...base, artifacts: [{ name: "markdown.wasm", sha256: sha, bytes: -1 }] },
      "oversize artifact": { ...base, artifacts: [{ name: "markdown.wasm", sha256: sha, bytes: 512 * 1024 ** 2 + 1 }] },
      "from in a resolved artifact": { ...base, artifacts: [{ name: "markdown.wasm", sha256: sha, bytes: 1, from: "x" }] },
    };
    for (const [label, value] of Object.entries(cases)) expectInvalid(() => decodeResolvedManifest(value), label);
  });
});

describe("control and invisible characters", () => {
  // What a terminal acts on, or a reader cannot see: escape sequences, line breaks, bidi overrides, zero-width marks.
  const BAD: readonly (readonly [string, string])[] = [
    ["an escape sequence", "\u001b[2K"], ["a line feed", "\n"], ["a carriage return", "\r"], ["a tab", "\t"], ["DEL", "\u007f"], ["a C1 control", "\u0085"],
    ["a bidi override", "\u202e"], ["a bidi isolate", "\u2066"], ["a zero-width space", "\u200b"], ["a byte order mark", "\ufeff"], ["a line separator", "\u2028"], ["a tag character", "\u{e0041}"],
  ];
  /** A copy of `root` with the value at `path` replaced. */
  function setAt(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
    const [head, ...rest] = path;
    if (head === undefined) return value;
    if (Array.isArray(root)) return Array.from<unknown>(root).map((item, index) => index === head ? setAt(item, rest, value) : item);
    if (typeof root === "object" && root !== null) return Object.fromEntries(Object.entries(root).map(([key, item]) => [key, key === head ? setAt(item, rest, value) : item]));
    return root;
  }
  const withField = (path: readonly (string | number)[], value: unknown): unknown => setAt(resolved(service), path, value);
  const FIELD_PATHS: readonly (readonly [string, readonly (string | number)[], (bad: string) => unknown])[] = [
    ["a guest file target", ["guestFiles", 0, "to"], bad => `/workspace/_oxidevm/${bad}x`],
    ["a mount path", ["mounts", 0, "guest"], bad => `/workspace/${bad}`],
    ["a durable path", ["state", "durable", 0], bad => `/workspace/data${bad}`],
    ["a guest executable", ["requires", "guest", "executables", 0], bad => `/usr/bin/${bad}python3`],
    ["a socket path", ["expose", "sql", "path"], bad => `/workspace/_oxidevm/s${bad}.sock`],
    ["a protocol", ["expose", "sql", "protocol"], bad => `oxidevm-sql/1${bad}`],
    ["the licence source", ["license", "source"], bad => `https://example.com/src${bad}`],
    ["an upstream name", ["upstream", 0, "name"], bad => `pglite${bad}`],
    ["an upstream source", ["upstream", 0, "source"], bad => `https://example.com/${bad}`],
    ["an option default", ["options", "dataDir", "default"], bad => `/workspace/pgdata${bad}`],
    ["an enum value", ["options", "durability", "values", 0], bad => `relaxed${bad}`],
  ];

  for (const [name, path, make] of FIELD_PATHS) {
    it(`rejects them in ${name}`, () => {
      for (const [kind, bad] of BAD) expectInvalid(() => decodeResolvedManifest(withField(path, make(bad))), `${name} with ${kind}`);
    });
  }

  it("still accepts ordinary non-ASCII text", () => {
    const decoded = decodeResolvedManifest(withField(["upstream", 0, "name"], "pglite \u2014 d\u00e9j\u00e0 \u65e5\u672c\u8a9e"));
    expect(decoded.upstream?.[0]?.name).toBe("pglite \u2014 d\u00e9j\u00e0 \u65e5\u672c\u8a9e");
  });
});

describe("file names within one release", () => {
  const withNames = (names: readonly string[]) => ({ ...command, artifacts: names.map(name => ({ name, from: `pkg/${name}` })) });

  it("rejects names that would overwrite another file once served copies are added or case is ignored", () => {
    const clashes: readonly (readonly string[])[] = [
      ["foo.js", "foo.js.bin"], ["A.wasm", "a.wasm"], ["Module.JSON"], ["ADAPTER.mjs"], ["adapter.mjs.bin"], ["sha256sums"], ["x.css", "X.CSS.bin"], ["Adapter.MJS.BIN"],
    ];
    for (const names of clashes) {
      expectInvalid(() => decodeDeclaration(withNames(names)), `declared ${names.join(" + ")}`);
      expectInvalid(() => decodeResolvedManifest(resolved(withNames(names))), `resolved ${names.join(" + ")}`);
    }
  });

  it("accepts names that only look alike", () => {
    for (const names of [["foo.js", "foo.json"], ["foo.js", "foo.js.map"], ["a.wasm", "b.wasm"], ["tool.wasm", "tool.wasm.gz"]]) {
      expect(decodeDeclaration(withNames(names)).artifacts.map(artifact => artifact.name).sort(), names.join(" + ")).toEqual([...names].sort());
    }
  });
});

describe("commands", () => {
  const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  const requiring = (executables: readonly string[]) => ({ host: ["files.sync"], guest: { executables } });

  it("decodes a command's names as a sorted set right after process, in a declaration and in module.json", () => {
    const declared = decodeDeclaration({ ...command, commands: ["python3", "python", "py.test-3+x_y"] });
    expect(Object.keys(declared)).toEqual(["id", "version", "abi", "artifacts", "process", "commands", "requires", "license"]);
    expect(declared).toMatchObject({ commands: ["py.test-3+x_y", "python", "python3"] });
    const manifest = decodeResolvedManifest({ ...resolved(command), commands: ["b", "a"] });
    expect(Object.keys(manifest)).toEqual(["schemaVersion", "id", "version", "abi", "adapter", "artifacts", "process", "commands", "requires", "license"]);
    expect(manifest).toMatchObject({ schemaVersion: 1, adapter: { api: 1 }, commands: ["a", "b"] });
  });

  it("accepts the edges of the grammar and another program's path among the guest executables", () => {
    const sixteen = Array.from({ length: 16 }, (_, index) => `tool${String(index).padStart(2, "0")}`);
    expect(decodeDeclaration({ ...command, commands: sixteen })).toMatchObject({ commands: sixteen });
    const edges = ["0", "a", "c++", "g.v", "x86_64-gcc", `a${"b".repeat(63)}`, "toxidevm"];
    expect(decodeDeclaration({ ...command, commands: edges })).toMatchObject({ commands: [...edges].sort() });
    const others = decodeDeclaration({ ...command, commands: ["python3"], requires: requiring(["/usr/bin/python3", "/usr/local/bin/python"]) });
    expect(others.requires.guest?.executables).toEqual(["/usr/bin/python3", "/usr/local/bin/python"]);
  });

  it("rejects every invalid list with a stable message that names the field, in a declaration and in module.json", () => {
    const notAName = /commands: ".*" is not a command name/u;
    const cases: readonly (readonly [string, typeof command | typeof service, Readonly<Record<string, unknown>>, RegExp])[] = [
      ["commands on a service", service, { commands: ["db"] }, /commands: a service cannot declare commands/u],
      ["an empty list", command, { commands: [] }, /commands: must name at least one command/u],
      ["a list that is not an array", command, { commands: "python" }, /commands: must be an array of at most 16 entries/u],
      ["a duplicate name", command, { commands: ["python", "python"] }, /commands: contains duplicates/u],
      ["seventeen names", command, { commands: Array.from({ length: 17 }, (_, index) => `tool${String(index)}`) }, /commands: must be an array of at most 16 entries/u],
      ["an uppercase name", command, { commands: ["Python"] }, notAName],
      ["a name with a slash", command, { commands: ["bin/python"] }, notAName],
      ["a name with NUL", command, { commands: ["py\u0000thon"] }, notAName],
      ["a name with a leading dot", command, { commands: [".python"] }, notAName],
      ["a name with a leading dash", command, { commands: ["-python"] }, notAName],
      ["a name with a space", command, { commands: ["py thon"] }, notAName],
      ["a name longer than 64 characters", command, { commands: [`a${"b".repeat(64)}`] }, notAName],
      ["an empty name", command, { commands: [""] }, notAName],
      ["a name that is not a string", command, { commands: [7] }, /commands must be a string/u],
      ["the reserved oxidevm prefix", command, { commands: ["oxidevm-python"] }, /commands: oxidevm-python starts with oxidevm, which is reserved/u],
      ["the bare reserved name", command, { commands: ["oxidevm"] }, /commands: oxidevm starts with oxidevm, which is reserved/u],
      ["its own stub as a required guest executable", command, { commands: ["python", "python3"], requires: requiring(["/usr/local/bin/python3"]) }, /commands: python3 is this module's own command, so requires\.guest\.executables cannot list \/usr\/local\/bin\/python3/u],
    ];
    for (const [label, base, change, message] of cases) {
      expectInvalid(() => decodeDeclaration({ ...base, ...change }), label, message);
      expectInvalid(() => decodeResolvedManifest({ ...resolved(base), ...change }), `${label} in module.json`, message);
    }
  });

  it("round-trips module.json byte for byte and refuses names that are not sorted as not canonical", () => {
    const manifest = decodeResolvedManifest({ ...resolved(command), commands: ["python3", "python"] });
    const bytes = encodeModuleManifest(manifest);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(`"process": {\n    "kind": "command"\n  },\n  "commands": [\n    "python",\n    "python3"\n  ],\n  "requires": {`);
    expect(decodeModuleManifest(bytes)).toEqual(manifest);
    expect(encodeModuleManifest(decodeModuleManifest(bytes))).toEqual(bytes);
    expectInvalid(() => decodeModuleManifest(new TextEncoder().encode(text.replace(`"python",\n    "python3"`, `"python3",\n    "python"`))), "unsorted names");
  });

  it("keeps the exact bytes of manifests that declare no commands", () => {
    // Digests of both fixtures' canonical module.json, recorded before the commands field existed.
    expect(digest(encodeModuleManifest(decodeResolvedManifest(resolved(command))))).toBe("43acbde6ab5e59150e08dec2b562715e3b1787229c90d2bdf006ea2bb5c9eb72");
    expect(digest(encodeModuleManifest(decodeResolvedManifest(resolved(service))))).toBe("caf97b952eec9c1f16ecc285e68e977ba0cb40d346e15907310d9e33ca6d7b8f");
  });
});

describe("the module networking standard (engine ADR 0029)", () => {
  const withHost = (host: readonly string[], extra: Readonly<Record<string, unknown>> = {}) => ({ ...command, requires: { host }, ...extra });
  const internet = (network: unknown) => withHost(["net.internet", "sockets.connect"], { network });

  it("declares one reach: none, VM-only (net.vm) or internet (net.internet), each needing Userspace API 146", () => {
    expect(moduleReach(decodeDeclaration(command).requires.host)).toBe("none");
    expect(moduleReach(decodeDeclaration(withHost(["net.vm"])).requires.host)).toBe("vm");
    expect(moduleReach(decodeDeclaration(withHost(["net.internet"])).requires.host)).toBe("internet");
    expect([CAPABILITY_MIN_API["net.vm"], CAPABILITY_MIN_API["net.internet"]]).toEqual([146, 146]);
    expect(manifestMinApi({ requires: { host: ["files.sync", "net.vm"] } })).toBe(146);
    expectInvalid(() => decodeDeclaration(withHost(["net.vm", "net.internet"])), "both reach tokens", /at most one reach token.*net\.internet already includes/u);
    expectInvalid(() => decodeResolvedManifest(resolved(withHost(["net.vm", "net.internet"]))), "both reach tokens in module.json", /at most one reach token/u);
  });

  it("reads a module.json from an earlier CLI with sockets.connect alone as VM-only, but refuses that declaration in a build", () => {
    expect(moduleReach(decodeResolvedManifest(resolved(withHost(["sockets.connect"]))).requires.host)).toBe("vm");
    expectInvalid(() => decodeDeclaration(withHost(["sockets.connect"])), "sockets.connect without a reach", /sockets\.connect needs a reach.*net\.vm.*net\.internet/u);
    expect(decodeDeclaration(withHost(["net.vm", "sockets.connect"])).requires.host).toEqual(["net.vm", "sockets.connect"]);
  });

  it("discloses hosts and a purpose only with net.internet, after requires, and round-trips module.json byte for byte", () => {
    const hosts = ["pypi.org", "*.pythonhosted.org", ...Array.from({ length: 30 }, (_, index) => `h${String(index)}.example.com`)];
    const declared = decodeDeclaration(internet({ hosts, purpose: "p".repeat(200) }));
    expect(declared.network?.hosts).toHaveLength(32);
    expect(Object.keys(declared).indexOf("network")).toBe(Object.keys(declared).indexOf("requires") + 1);
    const bytes = encodeModuleManifest(decodeResolvedManifest(resolved(internet({ purpose: "Python programs reach the internet through the VM", hosts: ["pypi.org", "*.pythonhosted.org"] }))));
    const manifest = decodeModuleManifest(bytes);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.network).toEqual({ hosts: ["*.pythonhosted.org", "pypi.org"], purpose: "Python programs reach the internet through the VM" });
    expect(Buffer.from(encodeModuleManifest(manifest)).equals(Buffer.from(bytes))).toBe(true);
    for (const [network, label] of [
      [{ hosts: [...hosts, "one-more.example.com"] }, "33 hosts"], [{ hosts: ["exa mple.com"] }, "a malformed name"], [{ hosts: ["*.*.example.com"] }, "a double wildcard"],
      [{ hosts: ["https://example.com"] }, "a URL"], [{ purpose: "p".repeat(201) }, "201 characters"], [{}, "nothing disclosed"],
    ] as const) expectInvalid(() => decodeDeclaration(internet(network)), label, /network/u);
    expectInvalid(() => decodeDeclaration(internet({ hosts: ["a.com"], extra: 1 })), "an unknown key", /extra/u);
    expectInvalid(() => decodeDeclaration(withHost(["net.vm"], { network: { hosts: ["pypi.org"] } })), "network on a VM-only module", /network.*net\.internet/u);
    expectInvalid(() => decodeResolvedManifest(resolved(withHost(["files.sync"], { network: { purpose: "x" } }))), "network without a reach", /network.*net\.internet/u);
  });
});

describe("upstream components", () => {
  // Pyodide ships 21 wheels, each its own upstream project; a release carries at most 64 artifacts, so 64 bounds it.
  const components = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `package-${String(index)}`, version: "1.0.0", source: `https://pypi.org/project/package-${String(index)}/` }));

  it("accepts one upstream component per artifact a release may carry, in a declaration and in module.json", () => {
    for (const count of [21, 64]) {
      expect(decodeDeclaration({ ...service, upstream: components(count) }).upstream).toHaveLength(count);
      expect(decodeResolvedManifest(resolved({ ...service, upstream: components(count) })).upstream).toHaveLength(count);
    }
  });

  it("stays bounded: more components than a release can carry artifacts are refused", () => {
    expectInvalid(() => decodeDeclaration({ ...service, upstream: components(65) }), "65 upstream components", /upstream: must be an array of at most 64 entries/u);
    expectInvalid(() => decodeResolvedManifest(resolved({ ...service, upstream: components(65) })), "65 upstream components in module.json", /upstream/u);
  });
});
