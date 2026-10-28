import { expect, it } from "vitest";
import { buildArgumentsIdentity, resolvedBuildkitImages, sourcePolicy } from "./buildkit-inputs.js";
import { validateDistributionBuildkit } from "./buildkit-inputs.js";

function provenance(identifier: string, digest = "a".repeat(64)) {
  return { buildType: "https://mobyproject.org/buildkit@v1", materials: [{ uri: "pkg:docker/alpine@3.23.3?platform=linux%2Famd64", digest: { sha256: digest } }], buildConfig: { llbDefinition: [{ op: { Op: { source: { identifier } } } }] } };
}
it("uses BuildKit's resolved material to freeze a moving tag without parsing Dockerfile instructions", () => {
  const identifier = "docker-image://docker.io/library/alpine:3.23.3";
  const pins = resolvedBuildkitImages(provenance(identifier));
  expect(pins).toEqual([{ identifier, pinnedIdentifier: `${identifier}@sha256:${"a".repeat(64)}` }]);
  expect(JSON.parse(sourcePolicy(pins)) as unknown).toMatchObject({ rules: [{ action: "CONVERT", selector: { identifier } }] });
});
it("preserves an already pinned multi-stage source and rejects missing resolution", () => {
  const identifier = `docker-image://docker.io/library/alpine:3.23.3@sha256:${"b".repeat(64)}`;
  expect(resolvedBuildkitImages(provenance(identifier))).toEqual([{ identifier, pinnedIdentifier: identifier }]);
  expect(() => resolvedBuildkitImages(provenance("docker-image://docker.io/library/unknown:latest"))).toThrow(/resolved/u);
});
it("hashes author arguments canonically without writing their values into the lock", () => {
  expect(buildArgumentsIdentity({ Z: "private", A: "first" })).toBe(buildArgumentsIdentity({ A: "first", Z: "private" }));
});
it("reports malformed material encoding as a bounded protocol error", () => {
  const value = provenance("docker-image://docker.io/library/alpine:3.23.3");
  value.materials[0] = { uri: "pkg:docker/%zz@3.23.3", digest: { sha256: "a".repeat(64) } };
  try { resolvedBuildkitImages(value); throw new Error("malformed material was admitted"); }
  catch (error) { expect(error).toMatchObject({ code: "PROTOCOL_ERROR" }); }
});
it("admits distribution RUN operations only with the actual offline LLB network value", () => {
  const definition = (network?: number) => ({ buildType: "https://mobyproject.org/buildkit@v1", buildConfig: { llbDefinition: [{ op: { Op: { exec: { ...(network === undefined ? {} : { network }) } } } }] } });
  expect(() => validateDistributionBuildkit(definition(2))).not.toThrow();
  for (const value of [definition(), definition(0), definition(1)]) expect(() => validateDistributionBuildkit(value)).toThrow(/offline/u);
});
it("rejects untracked remote and unsupported LLB source kinds in distribution builds", () => {
  for (const identifier of ["https://example.test/moving.tar", "git://example.test/project.git", "oci-layout://untracked", "local://unexpected"]) {
    expect(() => validateDistributionBuildkit(provenance(identifier))).toThrow(/source/u);
  }
  expect(() => validateDistributionBuildkit(provenance("local://context"))).not.toThrow();
  expect(() => validateDistributionBuildkit(provenance("docker-image://alpine:3.23.3"))).not.toThrow();
});
