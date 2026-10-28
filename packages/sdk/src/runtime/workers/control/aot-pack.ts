import type { AotCompilerRequest } from "./aot-compiler-protocol.js";

export function validateAotPackModule(
  module: WebAssembly.Module,
  request: Pick<AotCompilerRequest, "sourceSha256" | "memberCount">,
): void {
  const expectedImports = new Map([
    ["memory", "memory"],
    ["dispatch_table", "table"],
    ["record_dispatch_table", "table"],
    ["memory_access", "function"],
    ["invalidate_page", "function"],
    ["timestamp_counter", "function"],
    ["side_exit", "function"],
    ["floating_point", "function"],
    ["image_base", "global"],
  ]);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== expectedImports.size || imports.some((entry) =>
    entry.module !== "oxidevm" || expectedImports.get(entry.name) !== entry.kind
  )) throw new Error("AOT pack imports are incompatible");

  // Packs are entered through the core's dispatcher module, so they export only member tables.
  const expectedExports = new Map([
    ["member_table", "table"],
    ["record_member_table", "table"],
  ]);
  const exports = WebAssembly.Module.exports(module);
  if (exports.length !== expectedExports.size || exports.some((entry) =>
    expectedExports.get(entry.name) !== entry.kind
  )) throw new Error("AOT pack exports are incompatible");

  const sections = WebAssembly.Module.customSections(module, "oxidevm.aot-pack");
  if (sections.length !== request.memberCount) throw new Error("AOT pack member metadata count is invalid");
  let previousOffset = -1n;
  for (const raw of sections) {
    const bytes = new Uint8Array(raw);
    if (bytes.byteLength !== 48) throw new Error("AOT pack member metadata length is invalid");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sourceDigest = [...bytes.subarray(4, 36)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const offset = view.getBigUint64(36, true);
    const instructions = view.getUint16(44, true);
    const version = view.getUint32(0, true);
    const capabilityRevision = view.getUint8(46);
    if (
      (version !== 1 && version !== 2)
      || sourceDigest !== request.sourceSha256
      || offset <= previousOffset
      || instructions === 0
      || instructions > 128
      || capabilityRevision > 1
      || version === 1 && capabilityRevision !== 0
      || view.getUint8(47) !== 0
    ) throw new Error("AOT pack member metadata is invalid");
    previousOffset = offset;
  }
}
