import { exactKeys, record } from "../runtime/decode.js";
import { decodeSHA256 } from "../values.js";
import { VMError } from "../runtime/errors.js";
import { decodeBuildkitInputFacts } from "./buildkit-inputs.js";
import type { BuildkitInputFacts } from "./buildkit-inputs.js";

export type BuildInputFacts = BuildkitInputFacts | {
  readonly kind: "directory" | "archive" | "oci" | "boot-files";
  readonly sourceSHA256: string;
};

/** Nested lock facts obey the same closed schema as their signed evidence. */
export function decodeBuildInputFacts(value: unknown): BuildInputFacts {
  const input = record(value, "image build inputs");
  if (input["kind"] === "dockerfile") return decodeBuildkitInputFacts(input);
  exactKeys(input, ["kind", "sourceSHA256"]);
  const kind = input["kind"];
  if (kind !== "directory" && kind !== "archive" && kind !== "oci" && kind !== "boot-files") throw new VMError("PROTOCOL_ERROR", "unsupported image build input kind");
  return { kind, sourceSHA256: decodeSHA256(input["sourceSHA256"], "source identity") };
}
