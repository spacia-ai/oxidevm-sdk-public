import { exactKeys, record, string } from "../runtime/decode.js";

function rows(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 65_536) throw new Error(`${label} must be a nonempty bounded array`);
  return Array.from<unknown>(value).map(item => record(item, label));
}

/** Bun's aggregate MIT label cannot replace the terms of its linked LGPL libraries. */
export function validateNestedBunComponents(packages: readonly { readonly name: string; readonly license: string }[]): void {
  if (!packages.some(item => item.name.toLowerCase() === "bun")) return;
  for (const name of ["webkit", "tinycc"]) if (!packages.some(item => item.name.toLowerCase() === name && /(?:^|[^A-Za-z])LGPL-/u.test(item.license))) throw new Error(`Bun requires a nested ${name} source pin`);
}

/** Compare delivered components with independently reviewed recipe pins. Preserve every AND obligation. */
export function validateDistributionComponents(sbom: unknown, sources: unknown, expected: unknown): { readonly requiresRelink: boolean } {
  const packages = rows(record(sbom, "image SBOM")["packages"], "SBOM packages");
  const evidence = rows(record(sources, "image sources")["packages"], "source packages");
  const pins = rows(expected, "required component pins").map(value => {
    exactKeys(value, ["name", "version", "license"]);
    return { name: string(value["name"], "component name"), version: string(value["version"], "component version"), license: string(value["license"], "component license") };
  });
  if (new Set(pins.map(pin => JSON.stringify([pin.name, pin.version]))).size !== pins.length) throw new Error("Duplicate required component pin");
  validateNestedBunComponents(packages.map(item => ({ name: string(item["name"], "component name"), license: string(item["licenseConcluded"], "component license") })));
  let requiresRelink = false;
  for (const pin of pins) {
    const matches = packages.filter(item => item["name"] === pin.name && item["versionInfo"] === pin.version), component = matches[0];
    if (matches.length !== 1 || component === undefined || component["versionInfo"] !== pin.version || component["licenseConcluded"] !== pin.license) throw new Error(`Image lacks required component ${pin.name} at its pinned revision and license`);
    if (!/(?:^|[^A-Za-z])(?:GPL|LGPL|AGPL|MPL|EPL)-/u.test(pin.license)) continue;
    const source = evidence.find(item => item["packageId"] === component["SPDXID"]);
    if (source?.["kind"] !== "source" || source["archive"] === undefined || source["buildInstructions"] === undefined) throw new Error(`${pin.name} requires exact corresponding sources and build instructions`);
    if (pin.license.includes("LGPL-")) {
      requiresRelink = true;
      if (source["relinkMaterials"] === undefined) throw new Error(`${pin.name} requires practical relink materials`);
    }
  }
  if (packages.length !== pins.length) throw new Error("Image SBOM differs from its required component pins");
  return { requiresRelink };
}
