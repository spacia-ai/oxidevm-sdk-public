import { expect, it } from "vitest";
import { decodeBuildImageOptions } from "./build-options.js";

const valid = { recipeDir: "/project", signingKeyFile: "author.pem" };
it("copies and validates the local authoring boundary before side effects", () => {
  const secrets = [{ id: "registry", file: "token.txt" }];
  const decoded = decodeBuildImageOptions({ ...valid, publicBaseUrl: new URL("https://images.example/custom/"), secrets });
  expect(decoded.publicBaseUrl).toBe("https://images.example/custom/");
  expect(decoded.secrets).toEqual(secrets);
  expect(decoded.secrets).not.toBe(secrets);
});
it.each([
  null, { ...valid, extra: true }, { ...valid, purpose: "publish" },
  { ...valid, recipeDir: "" }, { ...valid, signingKeyFile: "x\0y" },
  { ...valid, outDir: 123 }, { ...valid, signal: {} }, { ...valid, onProgress: 1 },
  { ...valid, publicBaseUrl: "https://user:pass@images.example/" },
  { ...valid, publicBaseUrl: "/path?token=secret/" },
  { ...valid, secrets: [{ id: "a,b", file: "token" }] },
  { ...valid, secrets: [{ id: "same", file: "one" }, { id: "same", file: "two" }] },
])("rejects malformed build options: %j", value => {
  expect(() => decodeBuildImageOptions(value)).toThrow();
});
