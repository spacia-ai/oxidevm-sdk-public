import { describe, expect, it } from "vitest";
import { VMError } from "../runtime/errors.js";
import {
  decodeModulesDeclaration, decodeModulesDeclarationBytes, encodeModulesDeclaration, formatModuleSource, isTrustedSource, parseModuleSource,
} from "./declaration.js";

describe("module sources", () => {
  it("parses github and file sources and formats them back", () => {
    expect(parseModuleSource("github:spacia-ai/oxidevm-pglite@v0.1.0")).toEqual({ kind: "github", owner: "spacia-ai", repo: "oxidevm-pglite", tag: "v0.1.0" });
    expect(parseModuleSource("file:modules/local-tool")).toEqual({ kind: "file", path: "modules/local-tool" });
    for (const input of ["github:spacia-ai/oxidevm-pglite@v0.1.0", "file:modules/local-tool"]) expect(formatModuleSource(parseModuleSource(input))).toBe(input);
  });

  it("says what to do when a file: source points outside the project", () => {
    for (const input of ["file:../tool/dist", "file:/home/me/tool/dist", "file:vendor/../../tool"]) {
      expect(() => parseModuleSource(input), input).toThrow(/inside the project.*copy the release into the project.*file:vendor\/tool/u);
    }
    expect(() => parseModuleSource("file:a//b")).toThrow("normalized relative path");
  });

  it("rejects a repository called . or .., which would walk out of the API path repos/<owner>/<repo>", () => {
    for (const input of ["github:owner/.@v1", "github:owner/..@v1"]) expect(() => parseModuleSource(input), input).toThrow(VMError);
    expect(parseModuleSource("github:owner/.github@v1")).toMatchObject({ repo: ".github" });
    expect(parseModuleSource("github:owner/a..b@v1")).toMatchObject({ repo: "a..b" });
  });

  it("rejects sources that could escape, impersonate or fetch implicitly", () => {
    for (const input of [
      "", "github:owner/repo", "github:owner@v1", "github:/repo@v1", "github:owner/repo@", "github:owner/re po@v1", "github:-owner/repo@v1",
      "https://github.com/owner/repo", "npm:left-pad@1.0.0", "file:", "file:/etc", "file:../outside", "file:a/./b", "file:a//b", "latest",
    ]) expect(() => parseModuleSource(input), JSON.stringify(input)).toThrow(VMError);
  });

  it("trusts an owner or an exact repository, ignoring case, and never a file source", () => {
    const github = parseModuleSource("github:Spacia-AI/oxidevm-pglite@v1.0.0");
    expect(isTrustedSource(["spacia-ai"], github)).toBe(true);
    expect(isTrustedSource(["spacia-ai/oxidevm-pglite"], github)).toBe(true);
    expect(isTrustedSource(["spacia-ai/other"], github)).toBe(false);
    expect(isTrustedSource(["spacia"], github)).toBe(false);
    expect(isTrustedSource([], github)).toBe(false);
    expect(isTrustedSource(["spacia-ai"], parseModuleSource("file:modules/x"))).toBe(false);
  });
});

describe("oxidevm.modules.json", () => {
  const declaration = {
    schemaVersion: 1,
    trusted: ["spacia-ai"],
    modules: [{ id: "pyodide", from: "github:spacia-ai/oxidevm-pyodide@v0.1.0" }, { id: "pglite", from: "github:spacia-ai/oxidevm-pglite@v0.1.0" }],
  };

  it("sorts modules and trusted owners and round-trips through canonical bytes", () => {
    const decoded = decodeModulesDeclaration({ ...declaration, trusted: ["zeta", "Acme"] });
    expect(decoded.modules.map(module => module.id)).toEqual(["pglite", "pyodide"]);
    expect(decoded.trusted).toEqual(["Acme", "zeta"]);
    const bytes = encodeModulesDeclaration(decoded);
    expect(decodeModulesDeclarationBytes(bytes)).toEqual(decoded);
    expect(new TextDecoder().decode(bytes).endsWith("}\n")).toBe(true);
  });

  it("orders by code unit, so the bytes do not depend on the machine's locale", () => {
    // localeCompare puts "A" after "a-" in some locales and before it in others; the file is committed, so its bytes must not vary.
    expect(decodeModulesDeclaration({ ...declaration, trusted: ["b", "A", "a1", "C", "a-"] }).trusted).toEqual(["A", "C", "a-", "a1", "b"]);
    const ids = ["m-b", "m1", "ma", "m-a"];
    const modules = ids.map(id => ({ id, from: "file:x" }));
    expect(decodeModulesDeclaration({ ...declaration, modules }).modules.map(module => module.id)).toEqual(["m-a", "m-b", "m1", "ma"]);
  });

  it("rejects a trusted repository called . or ..", () => {
    for (const entry of ["acme/.", "acme/.."]) expect(() => decodeModulesDeclaration({ ...declaration, trusted: [entry] }), entry).toThrow(VMError);
    expect(decodeModulesDeclaration({ ...declaration, trusted: ["acme/.github"] }).trusted).toEqual(["acme/.github"]);
  });

  it("rejects an object that names a key twice, whatever the layout or spelling, because a reader and a reviewer would see different files", () => {
    const encoder = new TextEncoder();
    const twice = [
      '{"schemaVersion":1,"trusted":["acme"],"trusted":[],"modules":[]}',
      '{\n  "schemaVersion": 1,\n  "trusted": [],\n  "modules": [{"id":"a","from":"file:x","id":"b"}]\n}',
      '{"schemaVersion":1,"trusted":[],"modules":[],"\\u006dodules":[{"id":"a","from":"file:x"}]}',
    ];
    for (const text of twice) expect(() => decodeModulesDeclarationBytes(encoder.encode(text)), text).toThrow(/more than once/u);
    // The same key in different objects is fine, and so is a value that looks like a key.
    const fine = '{"schemaVersion":1,"trusted":["id","id2"],"modules":[{"id":"a","from":"file:id"},{"id":"b","from":"file:id"}]}';
    expect(decodeModulesDeclarationBytes(encoder.encode(fine)).modules).toHaveLength(2);
  });

  it("starts empty by default", () => {
    expect(decodeModulesDeclaration({ schemaVersion: 1, trusted: [], modules: [] })).toEqual({ schemaVersion: 1, trusted: [], modules: [] });
  });

  it("reads a hand-edited file in any layout and order, and the tool writes it back canonically", () => {
    const encoder = new TextEncoder();
    const normalized = decodeModulesDeclaration(declaration);
    // People edit this file: compact, indented with tabs or four spaces, unsorted, no final newline.
    const layouts = [
      JSON.stringify(declaration),
      JSON.stringify(declaration, null, 4),
      JSON.stringify(declaration, null, "\t"),
      `${JSON.stringify(declaration, null, 2)}\n\n`,
      `{ "schemaVersion": 1, "trusted": [ "spacia-ai" ],\n "modules": [ { "from": "github:spacia-ai/oxidevm-pyodide@v0.1.0", "id": "pyodide" }, { "id": "pglite", "from": "github:spacia-ai/oxidevm-pglite@v0.1.0" } ] }`,
    ];
    for (const layout of layouts) expect(decodeModulesDeclarationBytes(encoder.encode(layout)), layout).toEqual(normalized);
    // What the tool writes is the one canonical spelling, which reads back to the same declaration.
    const written = encodeModulesDeclaration(decodeModulesDeclarationBytes(encoder.encode(layouts[0] ?? "")));
    expect(new TextDecoder().decode(written)).toBe(`${JSON.stringify(normalized, null, 2)}\n`);
    expect(decodeModulesDeclarationBytes(written)).toEqual(normalized);
  });

  it("still rejects bad content read from a file: unknown keys, wrong types, duplicates and oversize input", () => {
    const encoder = new TextEncoder();
    expect(() => decodeModulesDeclarationBytes(encoder.encode(JSON.stringify({ ...declaration, extra: 1 })))).toThrow(VMError);
    expect(() => decodeModulesDeclarationBytes(encoder.encode(JSON.stringify({ ...declaration, trusted: "spacia-ai" })))).toThrow(VMError);
    expect(() => decodeModulesDeclarationBytes(encoder.encode(JSON.stringify({ ...declaration, modules: [declaration.modules[0], declaration.modules[0]] })))).toThrow(VMError);
    expect(() => decodeModulesDeclarationBytes(encoder.encode("{ not json"))).toThrow(VMError);
    expect(() => decodeModulesDeclarationBytes(new Uint8Array(65 * 1024).fill(32))).toThrow(VMError);
  });

  it("rejects unknown keys, duplicates and malformed entries with a stable reason", () => {
    const cases: readonly unknown[] = [
      { ...declaration, extra: 1 },
      { ...declaration, schemaVersion: 2 },
      { ...declaration, trusted: ["spacia-ai", "SPACIA-AI"] },
      { ...declaration, trusted: ["spacia-ai/*"] },
      { ...declaration, trusted: [""] },
      { ...declaration, modules: [declaration.modules[0], declaration.modules[0]] },
      { ...declaration, modules: [{ id: "Bad", from: "file:x" }] },
      { ...declaration, modules: [{ id: "ok", from: "github:owner/repo" }] },
      { ...declaration, modules: [{ id: "ok", from: "file:x", extra: true }] },
      { ...declaration, modules: Array.from({ length: 65 }, (_, index) => ({ id: `m${String(index)}`, from: "file:x" })) },
    ];
    for (const value of cases) {
      expect(() => decodeModulesDeclaration(value)).toThrow(VMError);
      try { decodeModulesDeclaration(value); } catch (error: unknown) { expect(error).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } }); }
    }
  });
});
