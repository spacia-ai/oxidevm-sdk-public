import { parseArgs } from "node:util";
import { VMError } from "@oxidevm/sdk";
import type { RuntimeMode } from "@oxidevm/sdk";
import type { CliCommand } from "./contracts.js";

interface Common { readonly kind: "command"; readonly json: boolean }
interface SnapshotOptions {readonly browser?:"chromium"|"firefox"|"webkit";readonly timeoutMs?:number;readonly engineDir?:string}
interface SnapshotPublicationOptions extends SnapshotOptions {readonly recipe:string;readonly signingKey:string;readonly imageTrust?:string;readonly out?:string;readonly baseUrl?:string}
export type CLIInvocation = Common & (
  | {readonly command:"snapshot init";readonly directory:string;readonly name:string;readonly mode?:RuntimeMode;readonly image?:string;readonly imageTrust?:string}
  | ({readonly command:"snapshot build"}&SnapshotPublicationOptions)
  | ({readonly command:"snapshot pack";readonly backup:string}&SnapshotPublicationOptions)
  | ({readonly command:"snapshot test";readonly bundle:string;readonly trust:string;readonly verify?:string}&SnapshotOptions)
  | {readonly command:"snapshot inspect";readonly artifact:string;readonly trust?:string}
  | {readonly command:"wasm add";readonly source:string;readonly project:string;readonly yes:boolean;readonly offline:boolean}
  | {readonly command:"wasm stage";readonly project:string;readonly offline:boolean}
  | {readonly command:"wasm doctor";readonly project:string}
  | {readonly command:"wasm inspect";readonly file:string}
  | {readonly command:"wasm build";readonly project:string;readonly check:boolean;readonly out?:string;readonly module?:string}
  | {readonly command:"wasm release";readonly project:string;readonly out?:string;readonly module?:string;readonly repo?:string}
  | {readonly command:"wasm init";readonly directory:string;readonly moduleKind:"command"|"service";readonly id?:string;readonly from?:string}
  | { readonly command: "init"; readonly directory: string; readonly mode: RuntimeMode; readonly skipAssets: boolean; readonly start: boolean; readonly packageManager: "npm" | "bun"; readonly archives?: { readonly sdk: string; readonly cli: string }; readonly engineDir?: string; readonly image?: { readonly bundle: string; readonly trust: string } }
  | { readonly command: "assets install"; readonly config: string; readonly image?: string;readonly snapshot?:string;readonly trust?:string; readonly reference?: string; readonly engineDir?: string }
  | { readonly command: "doctor"; readonly url: string; readonly browser: "chromium" | "firefox" | "webkit"; readonly previewOrigin?: string }
  | { readonly command: "image init"; readonly directory: string; readonly mode: RuntimeMode }
  | { readonly command: "image keygen"; readonly out: string }
  | { readonly command: "image build"; readonly recipe: string; readonly signingKey: string; readonly out?: string; readonly baseUrl?: string; readonly distribution: boolean; readonly secrets: readonly { readonly id: string; readonly file: string }[] }
  | { readonly command: "image test"; readonly bundle: string; readonly trust: string; readonly browser: "chromium" | "firefox" | "webkit"; readonly distribution: boolean; readonly engineDir?: string }
  | { readonly command: "image inspect"; readonly bundle: string; readonly trust?: string }
  | { readonly command: "image pack"; readonly bundle: string; readonly trust: string }
);
export type ParsedArguments = CLIInvocation | { readonly kind: "help" | "version"; readonly json: boolean;readonly command?:CliCommand };

function invalid(message: string): never { throw new VMError("INVALID_ARGUMENT", message); }
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || value.includes("\0")) return invalid(`${label} is required and must be bounded text`);
  return value;
}
const allowed: Readonly<Record<CliCommand, readonly string[]>> = {
  init: ["mode", "skip-assets", "engine-dir", "image", "image-trust", "start", "use-bun", "sdk-archive", "cli-archive"], "assets install": ["config", "image", "snapshot", "trust", "reference", "engine-dir"], doctor: ["browser", "preview-origin"],
  "image init": ["mode"], "image keygen": ["out"], "image build": ["signing-key", "out", "base-url", "distribution", "secret"], "image test": ["trust", "browser", "distribution", "engine-dir"], "image inspect": ["trust"], "image pack": ["trust"],
  "snapshot pack":["recipe","signing-key","image-trust","out","base-url","browser","timeout-ms","engine-dir"],"snapshot test":["trust","verify","browser","timeout-ms","engine-dir"],"snapshot inspect":["trust"],
  "snapshot init":["name","mode","image","image-trust"],"snapshot build":["signing-key","image-trust","out","base-url","browser","timeout-ms","engine-dir"],
  "wasm add":["project","yes","offline"],"wasm stage":["project","offline"],"wasm doctor":["project"],"wasm inspect":[],
  "wasm build":["project","out","module","check"],"wasm release":["project","out","module","repo"],"wasm init":["kind","id","from"],
};

/** Node parses the fixed CLI grammar; validate correlations before acquiring any resource. */
export function parseArguments(arguments_: readonly string[], environment: Readonly<Record<string, string | undefined>>): ParsedArguments {
  let parsed;
  try {
    parsed = parseArgs({ args: [...arguments_], allowPositionals: true, strict: true, tokens: true, options: {
      json: { type: "boolean" }, help: { type: "boolean" }, version: { type: "boolean" }, mode: { type: "string" },
      "skip-assets": { type: "boolean" }, config: { type: "string" }, image: { type: "string" }, reference: { type: "string" },
      browser: { type: "string" }, "preview-origin": { type: "string" }, out: { type: "string" }, "signing-key": { type: "string" }, "base-url": { type: "string" },
      distribution: { type: "boolean" }, trust: { type: "string" }, secret: { type: "string", multiple: true }, "engine-dir": { type: "string" },
      recipe:{type:"string"},"image-trust":{type:"string"},verify:{type:"string"},"timeout-ms":{type:"string"},
      name:{type:"string"},
      snapshot:{type:"string"},
      project:{type:"string"},yes:{type:"boolean"},offline:{type:"boolean"},
      module:{type:"string"},check:{type:"boolean"},kind:{type:"string"},id:{type:"string"},from:{type:"string"},repo:{type:"string"},
      start: { type: "boolean" }, "use-bun": { type: "boolean" }, "sdk-archive": { type: "string" }, "cli-archive": { type: "string" },
    } });
  } catch { return invalid("unknown flag or missing flag value; use --help"); }
  const json = parsed.values.json === true;
  if (parsed.values.help === true || parsed.values.version === true) {
    if (parsed.values.help === true && parsed.values.version === true) return invalid("--help and --version cannot be combined");
    if(json)return invalid("Use help or version without --json");
    const prefix=parsed.positionals.slice(0,2).join(" ");
    if(parsed.values.help===true&&(prefix.startsWith("snapshot ")||prefix.startsWith("wasm "))&&isCommand(prefix))return {kind:"help",json,command:prefix};
    return { kind: parsed.values.help === true ? "help" : "version", json };
  }
  const [first, second] = parsed.positionals;
  const grouped = first === "image" || first === "assets" || first === "snapshot" || first === "wasm";
  const prefix = grouped ? `${first} ${second ?? ""}` : first;
  let command: CliCommand | undefined;
  for (const known of Object.keys(allowed)) if (known === prefix && isCommand(known)) command = known;
  if (command === undefined) return invalid("unknown or missing command; use --help");
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (token.name !== "json" && !allowed[command].includes(token.name)) return invalid(`--${token.name} is not supported by ${command}`);
    if (seen.has(token.name) && token.name !== "secret") return invalid(`--${token.name} was repeated`);
    seen.add(token.name);
  }
  const positional = parsed.positionals.slice(grouped ? 2 : 1);
  const count = command === "assets install" || command === "image keygen" || command === "wasm stage" || command === "wasm doctor" || command === "wasm build" || command === "wasm release" ? 0 : 1;
  if (positional.length > count || command !== "doctor"&&command!=="snapshot init"&&command!=="snapshot build" && positional.length !== count) return invalid("unexpected or missing positional arguments");
  const argument = () => nonempty(positional[0], "command path");
  const mode = (): RuntimeMode => {
    if (parsed.values.mode === "system") return "system";
    if (parsed.values.mode === "userspace") return "userspace";
    return invalid("--mode must be system or userspace");
  };
  const browser = ():NonNullable<SnapshotOptions["browser"]> => {
    const value = parsed.values.browser ?? "chromium";
    if (value === "chromium" || value === "firefox" || value === "webkit") return value;
    return invalid("--browser must be chromium, firefox or webkit");
  };
  const common = { kind: "command" as const, json };
  // The SDK pins an engine release it does not contain; --engine-dir names a local copy of it.
  const engineDir = parsed.values["engine-dir"] === undefined ? {} : { engineDir: nonempty(parsed.values["engine-dir"], "--engine-dir") };
  let timeoutMs:number|undefined;
  if(parsed.values["timeout-ms"]!==undefined){
    const raw=parsed.values["timeout-ms"];if(!/^[1-9][0-9]*$/u.test(raw))return invalid("--timeout-ms must be an integer");
    timeoutMs=Number(raw);if(!Number.isSafeInteger(timeoutMs)||timeoutMs>2_147_483_647)return invalid("--timeout-ms exceeds the timer bound");
  }
  const snapshotOptions={...engineDir,...(parsed.values.browser===undefined?{}:{browser:browser()}),...(timeoutMs===undefined?{}:{timeoutMs})};
  switch (command) {
    case "snapshot init":return {...common,command,directory:positional[0]??"snapshots/ready",name:nonempty(parsed.values.name??"ready","snapshot name"),
      ...(parsed.values.mode===undefined?{}:{mode:mode()}),...(parsed.values.image===undefined?{}:{image:nonempty(parsed.values.image,"--image")}),
      ...(parsed.values["image-trust"]===undefined?{}:{imageTrust:nonempty(parsed.values["image-trust"],"--image-trust")})};
    case "wasm add": return {...common,command,source:argument(),project:parsed.values.project??".",yes:parsed.values.yes===true,offline:parsed.values.offline===true};
    case "wasm stage": return {...common,command,project:parsed.values.project??".",offline:parsed.values.offline===true};
    case "wasm doctor": return {...common,command,project:parsed.values.project??"."};
    case "wasm inspect": return {...common,command,file:argument()};
    case "wasm build": return {...common,command,project:parsed.values.project??".",check:parsed.values.check===true,...(parsed.values.out===undefined?{}:{out:nonempty(parsed.values.out,"--out")}),...(parsed.values.module===undefined?{}:{module:nonempty(parsed.values.module,"--module")})};
    case "wasm release": {
      const repo=parsed.values.repo;
      if(repo!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u.test(repo))return invalid("--repo must be owner/name");
      return {...common,command,project:parsed.values.project??".",...(parsed.values.out===undefined?{}:{out:nonempty(parsed.values.out,"--out")}),...(parsed.values.module===undefined?{}:{module:nonempty(parsed.values.module,"--module")}),...(repo===undefined?{}:{repo})};
    }
    case "wasm init": {
      const moduleKind=parsed.values.kind??"command";
      if(moduleKind!=="command"&&moduleKind!=="service")return invalid("--kind must be command or service");
      return {...common,command,directory:argument(),moduleKind,...(parsed.values.id===undefined?{}:{id:nonempty(parsed.values.id,"--id")}),...(parsed.values.from===undefined?{}:{from:nonempty(parsed.values.from,"--from")})};
    }
    case "snapshot build":
    case "snapshot pack":{
      const options={...common,recipe:command==="snapshot build"?positional[0]??"oxidevm.snapshot.ts":parsed.values.recipe??"oxidevm.snapshot.ts",signingKey:nonempty(parsed.values["signing-key"]??environment["OXIDEVM_SIGNING_KEY_FILE"],"snapshot signing key"),
      ...(parsed.values["image-trust"]===undefined?{}:{imageTrust:nonempty(parsed.values["image-trust"],"--image-trust")}),...(parsed.values.out===undefined?{}:{out:nonempty(parsed.values.out,"--out")}),...(parsed.values["base-url"]===undefined?{}:{baseUrl:nonempty(parsed.values["base-url"],"--base-url")}),...snapshotOptions};
      return command==="snapshot build"?{...options,command}:{...options,command,backup:argument()};
    }
    case "snapshot test":return {...common,command,bundle:argument(),trust:nonempty(parsed.values.trust??environment["OXIDEVM_SNAPSHOT_TRUST_FILE"],"snapshot author trust"),
      ...(parsed.values.verify===undefined?{}:{verify:nonempty(parsed.values.verify,"--verify")}),...snapshotOptions};
    case "snapshot inspect":{const trust=parsed.values.trust??environment["OXIDEVM_SNAPSHOT_TRUST_FILE"];return {...common,command,artifact:argument(),...(trust===undefined?{}:{trust:nonempty(trust,"snapshot author trust")})};}
    case "init": {
      if (parsed.values.start === true && (parsed.values["skip-assets"] === true || json)) return invalid("--start requires installed assets and cannot be combined with --json");
      const sdk = parsed.values["sdk-archive"], cli = parsed.values["cli-archive"];
      if ((sdk === undefined) !== (cli === undefined)) return invalid("--sdk-archive and --cli-archive must be supplied together");
      const archives = sdk === undefined ? {} : { archives: { sdk: nonempty(sdk, "--sdk-archive"), cli: nonempty(cli, "--cli-archive") } };
      if (parsed.values["skip-assets"] === true && parsed.values["engine-dir"] !== undefined) return invalid("--engine-dir installs assets and cannot be combined with --skip-assets");
      const bundle = parsed.values.image, trust = parsed.values["image-trust"];
      if ((bundle === undefined) !== (trust === undefined)) return invalid("--image and --image-trust must be supplied together");
      const image = bundle === undefined ? undefined : { bundle: nonempty(bundle, "--image"), trust: nonempty(trust, "--image-trust") };
      return { ...common, command, directory: argument(), mode: parsed.values.mode === undefined ? "userspace" : mode(), skipAssets: parsed.values["skip-assets"] === true, start: parsed.values.start === true, packageManager: parsed.values["use-bun"] === true ? "bun" : "npm", ...archives, ...engineDir, ...(image === undefined ? {} : { image }) };
    }
    case "assets install": {
      if(parsed.values.snapshot!==undefined&&parsed.values.image!==undefined)return invalid("--snapshot and --image are exclusive");
      if (parsed.values.reference !== undefined && parsed.values.image === undefined&&parsed.values.snapshot===undefined) return invalid("--reference requires --image or --snapshot");
      if(parsed.values.trust!==undefined&&parsed.values.snapshot===undefined&&parsed.values.image===undefined)return invalid("--trust requires --snapshot or --image");
      const snapshot=parsed.values.snapshot===undefined?{}:{snapshot:nonempty(parsed.values.snapshot,"--snapshot"),trust:nonempty(parsed.values.trust??environment["OXIDEVM_SNAPSHOT_TRUST_FILE"],"snapshot author trust")};
      return { ...common, command, config: parsed.values.config ?? "oxidevm.config.ts", ...(parsed.values.image === undefined ? {} : { image: nonempty(parsed.values.image, "--image") }), ...(parsed.values.trust === undefined ? {} : { trust: nonempty(parsed.values.trust, "--trust") }), ...snapshot, ...(parsed.values.reference === undefined ? {} : { reference: nonempty(parsed.values.reference, "--reference") }), ...engineDir };
    }
    case "doctor": return { ...common, command, url: positional[0] ?? "http://localhost:5173/", browser: browser(), ...(parsed.values["preview-origin"] === undefined ? {} : { previewOrigin: nonempty(parsed.values["preview-origin"], "--preview-origin") }) };
    case "image init": return { ...common, command, directory: argument(), mode: mode() };
    case "image keygen": return { ...common, command, out: nonempty(parsed.values.out, "--out") };
    case "image build": {
      const secrets = (parsed.values.secret ?? []).map(value => {
        const separator = value.indexOf("="); const id = value.slice(0, separator); const file = value.slice(separator + 1);
        if (separator < 1 || !/^[A-Za-z0-9_-]{1,64}$/u.test(id) || file.length === 0) return invalid("--secret must be id=path");
        return { id, file };
      });
      if (new Set(secrets.map(secret => secret.id)).size !== secrets.length) return invalid("duplicate BuildKit secret id");
      return { ...common, command, recipe: argument(), signingKey: nonempty(parsed.values["signing-key"] ?? environment["OXIDEVM_SIGNING_KEY_FILE"], "--signing-key or OXIDEVM_SIGNING_KEY_FILE"), distribution: parsed.values.distribution === true, secrets, ...(parsed.values.out === undefined ? {} : { out: nonempty(parsed.values.out, "--out") }), ...(parsed.values["base-url"] === undefined ? {} : { baseUrl: nonempty(parsed.values["base-url"], "--base-url") }) };
    }
    case "image test": return { ...common, command, bundle: argument(), trust: nonempty(parsed.values.trust ?? environment["OXIDEVM_IMAGE_TRUST_FILE"], "--trust or OXIDEVM_IMAGE_TRUST_FILE"), browser: browser(), distribution: parsed.values.distribution === true, ...engineDir };
    case "image inspect": return { ...common, command, bundle: argument(), ...(parsed.values.trust === undefined ? {} : { trust: nonempty(parsed.values.trust, "--trust") }) };
    case "image pack": return { ...common, command, bundle: argument(), trust: nonempty(parsed.values.trust, "--trust") };
  }
}
function isCommand(value: string): value is CliCommand { return Object.hasOwn(allowed, value); }
