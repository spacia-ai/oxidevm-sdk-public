import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { VMError } from "@oxidevm/sdk";
import type { ImageRef, RuntimeMode, TrustedImageKey } from "@oxidevm/sdk";
import { createProjectLock, getSDKRelease, installProjectAssets, loadImageReference, pinnedEngineCompliance } from "@oxidevm/sdk/image-builder";
import type { ImageRecipe, ProjectConfig } from "@oxidevm/sdk/image-builder";
import {newDirectory,file} from "./template-files.js";
import { object, text } from "./validation.js";
import { archiveDependencies, writeStarter } from "./starter-template.js";

const alpine = "alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659";
async function registryConfig(): Promise<string | undefined> {
  const value: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = object(value, "CLI manifest");
  if (manifest["publishConfig"] === undefined) return undefined;
  const registry = text(object(manifest["publishConfig"], "publish configuration")["registry"]);
  const url = new URL(registry);
  if (url.href === "https://registry.npmjs.org/") return undefined;
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new VMError("INVALID_ARGUMENT", "package registry must be HTTP(S) without credentials");
  return `@oxidevm:registry=${url.href}\n`;
}

export async function initializeImage(directory: string, mode: RuntimeMode): Promise<{ readonly directory: string; readonly recipePath: string; readonly mode: RuntimeMode }> {
  await newDirectory(directory);
  const name = "custom-linux";
  const common = { id: name, version: "1.0.0", sourceDateEpoch: 0, smokeTest: { command: "/bin/sh", args: ["-c", "printf oxidevm-ready"], expectedExitCode: 0 as const, stdoutIncludes: "oxidevm-ready" } };
  const recipe: ImageRecipe = mode === "system"
    ? { ...common, mode, source: { kind: "boot-files", kernel: { path: "kernel.bzImage", sha256: "0".repeat(64) }, disk: { path: "disk.img", sha256: "0".repeat(64) }, commandLine: "console=hvc0 root=/dev/vda rw" } }
    : { ...common, mode, source: { kind: "dockerfile", context: ".", file: "Dockerfile" } };
  if (mode === "userspace") {
    await file(directory, "Dockerfile", `FROM ${alpine}\nRUN mkdir -p /workspace\nWORKDIR /workspace\n`);
    await file(directory, ".dockerignore", "*.pem\n*.public.json\ndist/\nnode_modules/\n.git/\n");
  }
  await file(directory, "oxidevm.image.ts", `import type { ImageRecipe } from "@oxidevm/sdk/image-builder";\n\nexport default ${JSON.stringify(recipe, null, 2)} satisfies ImageRecipe;\n`);
  await file(directory, "image.lock.json", `${JSON.stringify({ schemaVersion: 2, kind: "build-inputs", mode, id: name, version: "1.0.0", sourceDateEpoch: 0 }, null, 2)}\n`);
  await file(directory, ".gitignore", "*.pem\n*.key\nkernel.bzImage\ndisk.img\ndist/\nnode_modules/\n");
  const setup = mode === "system" ? "Supply your own kernel.bzImage and disk.img. Replace the placeholder SHA-256 values with their actual checksums and set the correct boot command line. Build a disk with the compatible guest-agent integration for workspace/process APIs. This release supplies no managed kernel bootstrap. Keep guest binaries outside Git." : "Edit the Dockerfile and typed recipe. Keep the base pinned to its immutable digest.";
  await file(directory, "README.md", `# Custom Linux image\n\n${setup}\n\nCreate a signing key once with \`oxidevm image keygen --out author.pem\`. Build with \`oxidevm image build oxidevm.image.ts --signing-key author.pem\`, then run \`oxidevm image test dist --trust author.public.json\`. Development builds report missing redistribution evidence. Add reviewed SBOM, notices, corresponding sources and license policy before requesting \`--distribution\`.\n`);
  return { directory, recipePath: join(directory, "oxidevm.image.ts"), mode };
}

interface ApplicationInputs {
  readonly engineDir?: string;
  readonly engineComplianceDir?: string;
  readonly materialsUrl?: string;
  readonly productionImage?: ImageRef<"userspace">;
  readonly image?: { readonly bundle: string; readonly trust: TrustedImageKey };
  readonly archives?: { readonly sdk: string; readonly cli: string };
}

export async function initializeApplication(directory: string, mode: RuntimeMode, skipAssets: boolean, signal: AbortSignal, inputs: ApplicationInputs = {}): Promise<{ readonly directory: string; readonly mode: RuntimeMode; readonly assets: "installed" | "skipped" }> {
  const supplied = inputs.image === undefined ? undefined : await loadImageReference(inputs.image.bundle, inputs.image.trust);
  if (supplied !== undefined && supplied.mode !== mode) throw new VMError("INVALID_ARGUMENT", "image bundle must match the application mode");
  const image = supplied === undefined ? inputs.productionImage : { mode, manifestUrl: `/oxidevm/images/${supplied.manifestSHA256}/manifest.json`, manifestSHA256: supplied.manifestSHA256, trust: supplied.trust };
  const config: ProjectConfig = { mode, publicDir: mode === "userspace" ? ".oxidevm/assets" : "public", assetBaseUrl: "/oxidevm/", ...(image === undefined ? {} : { image }) };
  const lock = createProjectLock(config);
  const selfHosted = inputs.engineDir !== undefined;
  const stageAssets = !skipAssets && (selfHosted || inputs.image !== undefined);
  const npmrc = await registryConfig();
  const archives = await archiveDependencies(inputs.archives);
  await newDirectory(directory); await mkdir(join(directory, "src"));
  await file(directory, "LICENSE", await readFile(new URL("../LICENSE", import.meta.url), "utf8"));
  await file(directory, "NOTICE", await readFile(new URL("../NOTICE", import.meta.url), "utf8"));
  const compliance = pinnedEngineCompliance();
  const materials = inputs.materialsUrl;
  await file(directory, "LICENSES.md", `# Licenses and deployment\n\nThe SDK, CLI, and generated application code use Apache-2.0. Keep LICENSE\nand NOTICE with redistributed code. Dependencies retain their own licenses.\nBoth installed packages include THIRD_PARTY_NOTICES.txt and sbom.cdx.json.\nFonts retain their OFL license files in public/fonts.\n\nThe OxideVM engine is proprietary and distributed separately. Local\ndevelopment also permits work on commercial projects. Commercial production\nrequires a Spacia agreement. Non-commercial hosted deployments use the\nregistered public-license process. Licensed self-hosting is explicit.\n${compliance === null ? "" : `\n[Engine terms](${new URL("RUNTIME-LICENSE.txt", compliance.url).href})\naccompany the immutable compliance revision ${compliance.sha256}.\nThe runtime retains verified terms, notices, and the artifact SBOM.\n`}\nDevelopment and production use the hosted runtime by default. It does not copy engine\nbinaries into your deployment. The existing hosted service describes its\n[boot telemetry](https://run.oxidevm.dev/telemetry). Its service terms and privacy\nnotices also apply.\n\nThe nginx image is a collection of separately licensed programs. Engine\nrestrictions do not restrict rights granted by guest or dependency licenses.\nKeep corresponding sources, notices, license texts, and checksums with\nredistributed image binaries. You may modify and sign your own guest images.\n${materials === undefined ? "\nThe supplied image bundle contains its license and source materials.\n" : `\n[Image source and license materials](${materials}) accompany the signed image.\n`}`);
  await file(directory, "src/runtime.ts", `import type { RuntimeOptions } from "@oxidevm/sdk";\n\nconst runtime: RuntimeOptions = ${selfHosted ? 'import.meta.env.DEV ? { hosting: "self-hosted", baseUrl: "/oxidevm/runtime/" } : { hosting: "frame" }' : '{ hosting: "frame" }'};\nexport default runtime;\n`);
  const version = getSDKRelease().sdkVersion;
  await file(directory, "package.json", `${JSON.stringify({ name: "oxidevm-starter", version: "0.0.0", private: true, license: "Apache-2.0", type: "module", scripts: { dev: "vite", build: mode === "userspace" ? "tsc --noEmit && tsc -p tsconfig.node.json && vite build" : "tsc --noEmit && vite build", preview: "vite preview", assets: "oxidevm assets install", doctor: "oxidevm doctor" }, dependencies: { "@oxidevm/sdk": archives?.sdk ?? version, ...(mode === "userspace" ? { "@xterm/xterm": "6.0.0", "@xterm/addon-fit": "0.11.0" } : {}) }, devDependencies: { "@oxidevm/cli": archives?.cli ?? version, vite: "7.3.6", typescript: "6.0.3", "@types/node": "24.13.3" }, ...(archives === undefined ? {} : { overrides: { "@oxidevm/sdk": archives.sdk } }) }, null, 2)}\n`);
  if (archives !== undefined) await file(directory, "pnpm-workspace.yaml", `overrides:\n  '@oxidevm/sdk': ${JSON.stringify(archives.sdk)}\n`);
  if (npmrc !== undefined) await file(directory, ".npmrc", npmrc);
  await file(directory, "oxidevm.config.ts", `import type { ProjectConfig } from "@oxidevm/sdk/image-builder";\nexport default ${JSON.stringify(config, null, 2)} satisfies ProjectConfig;\n`);
  await file(directory, "oxidevm.lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  await file(directory, "tsconfig.json", `${JSON.stringify({ compilerOptions: { target: "ES2024", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2024", "DOM", "DOM.Iterable"], types: ["vite/client"], strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true, useUnknownInCatchVariables: true, skipLibCheck: false, noEmit: true, verbatimModuleSyntax: true, allowImportingTsExtensions: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, noImplicitReturns: true, noPropertyAccessFromIndexSignature: true, noUncheckedSideEffectImports: true }, include: ["src/**/*.ts"] }, null, 2)}\n`);
  if (mode === "userspace") {
    await writeStarter(directory);
    await file(directory, "src/image.ts", `// Generated by OxideVM assets install.\n${image === undefined ? 'import type { ImageRef } from "@oxidevm/sdk";\nconst image: ImageRef<"userspace"> | undefined = undefined;\nexport default image;' : `import { defineImage } from "@oxidevm/sdk";\nexport default defineImage(${JSON.stringify(image)});`}\n`);
    const production = inputs.productionImage ?? image;
    await file(directory, "src/production-image.ts", `// Generated by OxideVM assets install.\n${production === undefined ? 'import type { ImageRef } from "@oxidevm/sdk";\nconst image: ImageRef<"userspace"> | undefined = undefined;\nexport default image;' : `import { defineImage } from "@oxidevm/sdk";\nexport default defineImage(${JSON.stringify(production)});`}\n`);
  } else {
  await file(directory, "vite.config.ts", `import { defineConfig } from "vite";\nconst headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };\nexport default defineConfig({ server: { headers }, preview: { headers }, worker: { format: "es" }, optimizeDeps: { exclude: ["@oxidevm/sdk"] } });\n`);
  await file(directory, "index.html", '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="oxidevm-assets" content="/oxidevm/"><title>OxideVM</title></head><body><h1>Linux in your browser</h1><button id="run">Run Linux command</button><button id="cancel">Cancel startup</button><pre id="output" aria-live="polite"></pre><script type="module" src="/src/main.ts"></script></body></html>\n');
  const imageImport = image === undefined ? "" : ", defineImage";
  const imageOption = image === undefined ? "" : `image: defineImage(${JSON.stringify(image)}), `;
  await file(directory, "src/main.ts", `import { createVM, VMError${imageImport} } from "@oxidevm/sdk";\nimport runtime from "./runtime.ts";\n\nconst run = document.querySelector("#run");\nconst output = document.querySelector("#output");\nconst cancel = document.querySelector("#cancel");\nif (!(run instanceof HTMLButtonElement) || !(output instanceof HTMLElement) || !(cancel instanceof HTMLButtonElement)) throw new Error("Missing controls");\nlet controller: AbortController | undefined;\ncancel.addEventListener("click", () => controller?.abort());\nrun.addEventListener("click", () => {\n  if (controller !== undefined) return;\n  const current = new AbortController(); controller = current; run.disabled = true;\n  void (async () => {\n    const vm = await createVM({ mode: ${JSON.stringify(mode)}, runtime, ${imageOption}signal: current.signal, onProgress: progress => { output.textContent = "Opening Linux: " + progress.phase; } });\n    try {\n      const result = await vm.exec({ command: "/bin/sh", args: ["-c", "printf 'Hello from Linux\\n'"], signal: current.signal });\n      output.textContent = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) + "\\n" + JSON.stringify(result.exit);\n    } finally { await vm.dispose(); }\n  })().catch((error: unknown) => { output.textContent = error instanceof VMError ? error.code + ": " + error.message : "Linux could not complete"; }).finally(() => { controller = undefined; run.disabled = false; });\n});\n`);
  }
  await file(directory, ".gitignore", "node_modules/\ndist/\n.oxidevm/\npublic/oxidevm/\n*.pem\n*.key\n");
  const installation = npmrc === undefined ? "Install the SDK and CLI release archives with the documented pnpm override. " : "Keep the generated .npmrc so the @oxidevm scope uses this build's configured registry. ";
  if (mode === "system") await file(directory, "README.md", `# Linux browser application\n\nSelected mode: ${mode}.\n\n${installation}Run \`pnpm install\` and \`pnpm dev\`. Open the printed localhost URL and choose Run Linux command. Use \`pnpm exec oxidevm doctor\` against that URL to check the deployment. \`pnpm build\` produces static assets. Configure COOP and COEP on the production host as in vite.config.ts.\n\n${stageAssets ? "Pinned assets are installed; dependencies have not been installed.\n" : "The application selects the hosted runtime. Supply an explicit System image before starting the app.\n"}`);
  if (stageAssets) await installProjectAssets(directory, config, { signal, hosting: selfHosted ? "self-hosted" : "frame", ...(inputs.engineDir === undefined ? {} : { engineDir: inputs.engineDir }), ...(inputs.engineComplianceDir === undefined ? {} : { engineComplianceDir: inputs.engineComplianceDir }), ...(inputs.image === undefined ? {} : { imageDir: inputs.image.bundle, trust: inputs.image.trust }) });
  return { directory, mode, assets: stageAssets ? "installed" : "skipped" };
}
