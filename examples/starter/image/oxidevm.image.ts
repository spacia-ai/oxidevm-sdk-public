import type { UserspaceImageRecipe } from "@oxidevm/sdk/image-builder";

export default {
  mode: "userspace", id: "oxidevm-starter-nginx", version: "0.0.7",
  sourceDateEpoch: 1792886400,
  source: { kind: "dockerfile", context: ".", file: "Dockerfile" },
  resources: { memoryMiB: 512 },
  evidence: {
    sbom: { kind: "file", path: ".cache/evidence/sbom.spdx.json" },
    noticesFile: ".cache/evidence/notices.json",
    correspondingSourcesFile: ".cache/evidence/sources.json",
    licensePolicyFile: ".cache/evidence/policy.json",
  },
  smokeTest: {
    command: "/bin/sh", args: ["-c", "test \"$(id -u)\" = 1000 && /usr/sbin/nginx -v && printf 'oxidevm-nginx-ready\\n'"],
    expectedExitCode: 0, stdoutIncludes: "oxidevm-nginx-ready",
  },
} satisfies UserspaceImageRecipe;
