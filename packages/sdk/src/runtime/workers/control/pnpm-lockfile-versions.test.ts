import { expect, it } from "vitest";
import { lockedPackageVersions } from "./pnpm-lockfile-versions.js";

const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      next:
        specifier: 16.2.12
        version: 16.2.12(react-dom@19.2.4(react@19.2.4))(react@19.2.4)

packages:

  '@emnapi/runtime@1.11.3':
    resolution: {integrity: sha512-a}

  '@img/colour@1.1.0':
    resolution: {integrity: sha512-b}
    engines: {node: '>=18'}

  next@16.2.12:
    resolution: {integrity: sha512-c}
    engines: {node: '>=20.9.0'}

  next@15.0.0:
    resolution: {integrity: sha512-d}

  probe@file:../probe:
    resolution: {directory: ../probe, type: directory}

  tarball@https://example.test/tarball.tgz:
    resolution: {integrity: sha512-e, tarball: https://example.test/tarball.tgz}

snapshots:

  next@16.2.12(react-dom@19.2.4(react@19.2.4))(react@19.2.4):
    dependencies:
      react: 19.2.4
`;

it("reads every registry package version under the packages section", () => {
  expect(lockedPackageVersions(lockfile)).toEqual({
    "@emnapi/runtime": ["1.11.3"],
    "@img/colour": ["1.1.0"],
    next: ["16.2.12", "15.0.0"],
  });
});

it("returns nothing for a lockfile without a packages section and rejects unbounded input", () => {
  expect(lockedPackageVersions("lockfileVersion: '9.0'\nimporters:\n  .: {}\n")).toEqual({});
  expect(() => lockedPackageVersions("x".repeat(16 * 1024 * 1024 + 1))).toThrow(/bound/u);
  const many = `packages:\n${Array.from({ length: 65_537 }, (_, index) => `  p${index}@1.0.0:\n`).join("")}`;
  expect(() => lockedPackageVersions(many)).toThrow(/bound/u);
});
