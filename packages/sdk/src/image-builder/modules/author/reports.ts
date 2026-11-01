import { exactKeys, integer, record, string } from "../../../runtime/decode.js";
import { decodeSHA256 } from "../../../values.js";
import { choice, decoding, invalid, list } from "../../../wasm/decode-support.js";
import type { Measured } from "../release.js";
import type { BundledPackage } from "./bundle.js";
import type { BuildResult } from "./build.js";
import { FINDING_CODES, MAX_BUNDLED_PACKAGES, MAX_FINDING_MESSAGE, MAX_PACKAGE_LICENSE, MAX_PACKAGE_NAME, MAX_PACKAGE_VERSION } from "./findings.js";
import type { Finding } from "./findings.js";

const MAX_TEXT = 1024;

function bounded(value: unknown, label: string, maximum = MAX_TEXT): string {
  const result = string(value, label);
  if (result.length > maximum || result.includes("\0")) return invalid(label, `must be at most ${String(maximum)} characters`);
  return result;
}

function decodeFinding(value: unknown): Finding {
  const item = record(value, "finding");
  exactKeys(item, ["severity", "code", "message"], ["file", "line", "column"]);
  return {
    severity: choice(item["severity"], "severity", ["error", "warning"]),
    code: choice(item["code"], "code", FINDING_CODES),
    message: bounded(item["message"], "message", MAX_FINDING_MESSAGE),
    ...item["file"] === undefined ? {} : { file: bounded(item["file"], "file") },
    ...item["line"] === undefined ? {} : { line: integer(item["line"], "line", 1, 2 ** 31) },
    ...item["column"] === undefined ? {} : { column: integer(item["column"], "column", 1, 2 ** 31) },
  };
}

function decodeFile(value: unknown): Measured {
  const item = record(value, "release file");
  exactKeys(item, ["name", "sha256", "bytes"]);
  return { name: bounded(item["name"], "name", 128), sha256: decodeSHA256(item["sha256"], "sha256"), bytes: integer(item["bytes"], "bytes", 0, 2 ** 40) };
}

function decodePackage(value: unknown): BundledPackage {
  const item = record(value, "bundled package");
  exactKeys(item, ["name", "version", "license"]);
  return { name: bounded(item["name"], "name", MAX_PACKAGE_NAME), version: bounded(item["version"], "version", MAX_PACKAGE_VERSION), license: bounded(item["license"], "license", MAX_PACKAGE_LICENSE) };
}

/** The `wasm build` result as the CLI prints it with `--json`; every field is exact and the three outcomes are consistent. */
export function decodeWasmBuildResult(value: unknown): BuildResult {
  return decoding("wasm build result", () => {
    const input = record(value, "wasm build result");
    exactKeys(input, ["result", "id", "version", "release", "directory", "files", "bundled", "findings"]);
    const result = choice(input["result"], "result", ["built", "checked", "failed"]);
    const nullable = (field: string, maximum: number): string | null => input[field] === null ? null : bounded(input[field], field, maximum);
    const id = nullable("id", 63), version = nullable("version", 128), directory = nullable("directory", 4096);
    const release = input["release"] === null ? null : decodeSHA256(input["release"], "release");
    const files = list(input["files"], "files", 70).map(decodeFile);
    const bundled = list(input["bundled"], "bundled", MAX_BUNDLED_PACKAGES).map(decodePackage);
    const findings = list(input["findings"], "findings", 512).map(decodeFinding);
    const errors = findings.some(item => item.severity === "error");
    if (new Set(files.map(file => file.name)).size !== files.length) invalid("files", "lists a file twice");
    if (result === "failed") {
      if (release !== null || directory !== null || files.length > 0 || !errors) invalid("result", "a failed build has errors and no release");
    } else {
      if (release === null || id === null || version === null || files.length === 0 || errors) invalid("result", "a successful build has a release, its files and no errors");
      if ((directory !== null) !== (result === "built")) invalid("directory", "is set exactly when the release was written");
    }
    return { result, id, version, release, directory, files, bundled, findings };
  });
}
