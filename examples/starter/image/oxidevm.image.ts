import { readFileSync } from "node:fs";
import type { UserspaceImageRecipe } from "@oxidevm/sdk/image-builder";

/** The files the smoke test reads, in order, so a first `python3` run downloads two packs instead of ten. */
const packFirst = readFileSync(new URL("pack-first.txt", import.meta.url), "utf8").split("\n").filter(line => line !== "" && !line.startsWith("#"));

export default {
  mode: "userspace", id: "oxidevm-starter-pandas", version: "0.0.2",
  sourceDateEpoch: 1792886400,
  source: { kind: "dockerfile", context: ".", file: "Dockerfile" },
  resources: { memoryMiB: 1536 },
  packFirst,
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
