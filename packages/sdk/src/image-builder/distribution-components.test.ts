import { expect, it } from "vitest";
import { validateDistributionComponents } from "./distribution-components.js";

it("retains distinct shipped versions of one dependency and rejects duplicate or changed pins", () => {
  const pins = ["1.0.0", "2.0.0"].map(version => ({ name: "fixture", version, license: "MIT" }));
  const sbom = { packages: pins.map(pin => ({ SPDXID: `SPDXRef-${pin.version}`, name: pin.name, versionInfo: pin.version, licenseConcluded: pin.license })) };
  const sources = { packages: sbom.packages.map(pkg => ({ packageId: pkg.SPDXID, kind: "notice-only" })) };
  expect(validateDistributionComponents(sbom, sources, pins)).toEqual({ requiresRelink: false });
  expect(() => validateDistributionComponents(sbom, sources, [pins[0], pins[0]])).toThrow("Duplicate");
  expect(() => validateDistributionComponents(sbom, sources, pins.map(pin => ({ ...pin, version: "3.0.0" })))).toThrow();
  expect(() => validateDistributionComponents(sbom, sources, pins.map(pin => ({ ...pin, license: "MIT AND MPL-2.0" })))).toThrow();
  expect(() => validateDistributionComponents({ packages: [...sbom.packages, sbom.packages[0]] }, sources, pins)).toThrow();
});
