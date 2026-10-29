import type { UserspaceImageRecipe } from "@oxidevm/sdk/image-builder";

export default {
  mode: "userspace", id: "oxidevm-starter-pandas", version: "0.0.1",
  sourceDateEpoch: 1792886400,
  source: { kind: "dockerfile", context: ".", file: "Dockerfile" },
  resources: { memoryMiB: 1536 },
  evidence: {
    sbom: { kind: "file", path: ".cache/candidate/evidence/sbom.spdx.json" },
    noticesFile: ".cache/candidate/evidence/notices.json",
    correspondingSourcesFile: ".cache/candidate/evidence/sources.json",
    licensePolicyFile: ".cache/candidate/evidence/policy.json",
  },
  smokeTest: {
    command: "/usr/bin/python3", args: ["-c", "import pandas,numpy; print(pandas.__version__, numpy.__version__)"],
    expectedExitCode: 0, stdoutIncludes: "2.3.3 2.2.6",
  },
} satisfies UserspaceImageRecipe;
