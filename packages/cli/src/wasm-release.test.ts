import type { WasmBuildResult } from "@oxidevm/sdk/image-builder";
import { describe, expect, it } from "vitest";
import { releasePlan, shellWord } from "./wasm-release.js";

const SHA = "b".repeat(64);
const BUILT: WasmBuildResult = { result: "built", id: "tool", version: "1.2.3", release: SHA, directory: "dist", files: [{ name: "module.json", sha256: SHA, bytes: 1 }], bundled: [], findings: [] };

describe("shellWord", () => {
  it("leaves plain words alone and quotes everything else", () => {
    expect(shellWord("dist")).toBe("dist");
    expect(shellWord("acme/tool")).toBe("acme/tool");
    expect(shellWord("v1.2.3-rc.1+build.5")).toBe("v1.2.3-rc.1+build.5");
    expect(shellWord("my dist")).toBe("'my dist'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(shellWord("$(id)")).toBe("'$(id)'");
    expect(shellWord("")).toBe("''");
  });
});

describe("releasePlan", () => {
  it("lists tag, draft, verify, publish and install, naming the release id the verification must reproduce", () => {
    const plan = releasePlan(BUILT, { directory: "dist" });
    expect(plan.tag).toBe("v1.2.3");
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps[0]).toContain("git tag v1.2.3 && git push origin v1.2.3");
    expect(plan.steps[1]).toContain("gh release create v1.2.3 dist/* --draft --verify-tag --title v1.2.3 --generate-notes");
    expect(plan.steps[2]).toContain("sha256sum --check SHA256SUMS");
    expect(plan.steps[2]).toContain(`must be the release id, ${SHA}.`);
    expect(plan.steps[3]).toContain("gh release edit v1.2.3 --draft=false");
    expect(plan.steps[4]).toContain("oxidevm wasm add github:OWNER/REPO@v1.2.3");
  });

  it("names the repository in every gh command and in the install line when given", () => {
    const plan = releasePlan(BUILT, { directory: "dist", repo: "acme/tool" });
    for (const index of [1, 2, 3]) expect(plan.steps[index]).toContain("--repo acme/tool");
    expect(plan.steps[4]).toContain("github:acme/tool@v1.2.3");
    expect(plan.steps.join("\n")).not.toContain("OWNER/REPO");
  });

  it("quotes a build directory that needs it, so the printed command is safe to paste", () => {
    expect(releasePlan(BUILT, { directory: "out dir" }).steps[1]).toContain("'out dir'/*");
  });

  it("has no tag and no steps when the build failed", () => {
    const failed: WasmBuildResult = { result: "failed", id: null, version: null, release: null, directory: null, files: [], bundled: [], findings: [{ severity: "error", code: "module-source", message: "x" }] };
    expect(releasePlan(failed, { directory: "dist" })).toEqual({ tag: null, steps: [] });
  });

  it("plans from a check-only result too, because a release id exists without a directory", () => {
    expect(releasePlan({ ...BUILT, result: "checked", directory: null }, { directory: "dist" }).tag).toBe("v1.2.3");
  });
});
