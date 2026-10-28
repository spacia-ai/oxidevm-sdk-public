import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { downloadBundle } from "../packages/sdk/dist/image-builder/download.js";
import { integer, record, string } from "../packages/sdk/src/runtime/decode.ts";
import { decodeHumanAuthorization, releaseDigest } from "./release-evidence.ts";

/** Trusted public code checks this binding before the job checks out or runs private scripts. */
export function approvedControllerSource(bytes: Uint8Array, authorization: unknown, expected: { readonly source: string; readonly commit: string; readonly candidate: string; readonly version: string }): string {
  if (bytes.length > 16 * 1024 ** 2 || createHash("sha256").update(bytes).digest("hex") !== expected.candidate) throw new Error("Approved publication manifest digest differs");
  const manifest = record(JSON.parse(new TextDecoder().decode(bytes)), "approved publication");
  if (manifest["schemaVersion"] !== 1 || manifest["target"] !== "public" || manifest["version"] !== expected.version || manifest["source"] !== expected.source || manifest["exportCommit"] !== expected.commit) throw new Error("Private controller source differs from the approved publication");
  decodeHumanAuthorization(authorization, { candidateSHA256: expected.candidate, legalScopeSHA256: releaseDigest(manifest["legalScopeSHA256"]) });
  return expected.source;
}

if (import.meta.main) {
  const env = (name: string) => string(process.env[name], name);
  const source = env("SOURCE"), commit = env("EXPORT_COMMIT"), candidate = env("CANDIDATE"), archive = env("ARCHIVE"), tag = env("REVIEW_TAG"), version = env("VERSION");
  if (process.env["GITHUB_ACTIONS"] !== "true" || process.env["RUNNER_ENVIRONMENT"] !== "github-hosted" || process.env["GITHUB_REPOSITORY"] !== "spacia-ai/oxidevm-sdk-public" || process.env["GITHUB_EVENT_NAME"] !== "workflow_dispatch" || commit !== env("GITHUB_SHA") || !/^[a-f0-9]{40}$/u.test(source) || !/^[a-f0-9]{64}$/u.test(candidate) || !/^[a-f0-9]{64}$/u.test(archive) || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version) || tag !== `public-candidate-${version}-${candidate.slice(0, 16)}`) throw new Error("Publication bootstrap requires exact protected-job inputs");
  const gh = (args: string[]): unknown => JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 4 * 1024 ** 2, timeout: 120_000 }));
  const identity = record(gh(["release", "view", tag, "--repo", "spacia-ai/oxidevm-sdk", "--json", "databaseId,tagName"]), "private draft identity");
  if (identity["tagName"] !== tag) throw new Error("Private review tag changed");
  const id = integer(identity["databaseId"], "release ID", 1, Number.MAX_SAFE_INTEGER), release = record(gh(["api", `repos/spacia-ai/oxidevm-sdk/releases/${String(id)}`]), "private review release");
  const assets = release["assets"]; if (release["draft"] !== true || !Array.isArray(assets)) throw new Error("Review input must remain a private draft");
  const asset = Array.from<unknown>(assets).map(value => record(value, "review asset")).find(item => item["name"] === `review-${candidate}.tgz`);
  if (asset === undefined) throw new Error("Approved review archive is missing");
  const assetId = integer(asset["id"], "asset ID", 1, Number.MAX_SAFE_INTEGER), bytes = integer(asset["size"], "archive size", 1, 2 * 1024 ** 3);
  const directory = resolve(".cache/publication-bootstrap", candidate);
  await downloadBundle({ url: `https://api.github.com/repos/spacia-ai/oxidevm-sdk/releases/assets/${String(assetId)}`, bytes, sha256: archive }, directory, async staging => {
    const manifest = await readFile(join(staging, "publication.json")), authorization: unknown = JSON.parse(await readFile(join(staging, "authorization.json"), "utf8"));
    approvedControllerSource(manifest, authorization, { source, commit, candidate, version });
    const reviews = decodeHumanAuthorization(authorization, { candidateSHA256: candidate, legalScopeSHA256: releaseDigest(record(JSON.parse(manifest.toString()), "publication")["legalScopeSHA256"]) });
    for (const review of Object.values(reviews)) if (createHash("sha256").update(await readFile(join(staging, review.evidence))).digest("hex") !== review.sha256) throw new Error("Human review evidence changed before controller checkout");
  });
  await appendFile(env("GITHUB_OUTPUT"), `source=${source}\n`);
}
