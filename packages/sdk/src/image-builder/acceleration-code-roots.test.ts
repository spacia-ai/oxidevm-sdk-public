import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAccelerationProfile } from "./acceleration.js";

it("versions image code roots without changing legacy profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-code-roots-"));
  try {
    const path = join(directory, "host");
    await writeFile(path, "host");
    const options = { profile: "node24-bun1-v1", dependencies: "/workspace/node_modules", host: { path, sha256: createHash("sha256").update("host").digest("hex") }, addons: [] } as const;
    const legacy = await createAccelerationProfile(options);
    expect(new TextDecoder().decode(legacy.bytes)).toMatch(/^OXAP\t1\n/u);
    const result = await createAccelerationProfile({ ...options, codeRoots: ["/usr/lib/node_modules/npm", "/usr/local/lib/pnpm"] });
    expect(new TextDecoder().decode(result.bytes)).toMatch(/^OXAP\t8\n/u);
    expect(new TextDecoder().decode(result.bytes)).toContain("code-root\t/usr/lib/node_modules/npm\n");
    for (const codeRoots of [["/"], ["/usr/../tmp"], ["/usr/lib/npm", "/usr/lib/npm"], ["/usr/lib/npm", "/usr/lib/npm/nested"], ["/workspace/node_modules"], ["/workspace"]]) {
      await expect(createAccelerationProfile({ ...options, codeRoots })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    const sparse: unknown[] = []; sparse.length = 1;
    for (const codeRoots of [null, sparse]) {
      const result: unknown = Reflect.apply(createAccelerationProfile, undefined, [{ ...options, codeRoots }]);
      await expect(result).rejects.toBeInstanceOf(Error);
    }
  } finally { await rm(directory, { recursive: true }); }
});
