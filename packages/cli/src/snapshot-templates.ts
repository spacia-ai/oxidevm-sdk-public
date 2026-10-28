import {join,relative,resolve} from "node:path";
import {VMError,type RuntimeMode,type TrustedImageKey} from "@oxidevm/sdk";
import {inspectImage,loadImageReference} from "@oxidevm/sdk/image-builder";
import {newDirectory,file} from "./template-files.js";
const send=`async function send(process: SnapshotProcess, input: string): Promise<void> {
  const writer = process.stdin.getWriter();
  try { await writer.write(new TextEncoder().encode(input)); }
  finally { writer.releaseLock(); }
}
`;
export function preparationSource(mode:RuntimeMode):string {
  return `import type { PrepareSnapshot, SnapshotProcess } from "@oxidevm/sdk";
${send}
const prepare: PrepareSnapshot = async ({ vm, start }) => {
  await vm.workspace.writeText("/welcome.txt", "Prepared workspace\\n");
  const token = crypto.randomUUID();
  const shell = await start("shell", { command: "/bin/sh", args: ["-i"],
    cwd: ${JSON.stringify(mode==="system"?"/":"/workspace")}, terminal: { columns: 80, rows: 24 } });
  await send(shell, "KEEP='" + token + "'; printf 'prepared:%s:%s\\\\n' \\"$KEEP\\" \\"$$\\"\\n");
  await shell.waitForOutput("prepared:" + token + ":" + String(shell.pid));
  return { token, pid: shell.pid };
};
export default prepare;
`;
}
export function verificationSource():string {
  return `import type { VerifySnapshot, SnapshotProcess } from "@oxidevm/sdk";
${send}
function proof(value: unknown): { token: string; pid: number } {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 2
    || !("token" in value) || typeof value.token !== "string"
    || !("pid" in value) || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Invalid captured proof");
  return { token: value.token, pid: value.pid };
}
const verify: VerifySnapshot = async ({ vm, data, attach }) => {
  const expected = proof(data);
  if (await vm.workspace.readText("/welcome.txt") !== "Prepared workspace\\n") throw new Error("Prepared file was not restored");
  const shell = await attach("shell");
  if (shell.pid !== expected.pid) throw new Error("Original shell PID changed");
  await send(shell, "printf 'restored:%s:%s\\\\n' \\"$KEEP\\" \\"$$\\"\\n");
  await shell.waitForOutput("restored:" + expected.token + ":" + String(expected.pid));
};
export default verify;
`;
}
export async function initializeSnapshot(directory:string,options:{name:string;mode?:RuntimeMode;imageDir?:string;imageTrust?:TrustedImageKey;signal:AbortSignal}):Promise<{directory:string;recipePath:string;name:string;mode:RuntimeMode;files:readonly string[]}> {
  if(!/^[a-z][a-z0-9-]{0,63}$/u.test(options.name))throw new VMError("INVALID_ARGUMENT","Snapshot name is invalid");
  if(options.signal.aborted)throw new VMError("ABORTED","Scaffolding was cancelled");
  let mode=options.mode??"userspace";
  if(options.imageDir!==undefined){
    if(options.imageTrust===undefined)throw new VMError("INVALID_ARGUMENT","Custom snapshot images require external image trust");
    const image=await loadImageReference(options.imageDir,options.imageTrust);await inspectImage(options.imageDir,{trust:options.imageTrust,signal:options.signal});
    if(options.mode!==undefined&&options.mode!==image.mode)throw new VMError("INVALID_ARGUMENT","Explicit mode conflicts with the supplied image");
    mode=image.mode;
  }
  await newDirectory(directory);
  const files=["oxidevm.snapshot.ts","prepare.ts","verify.ts","tsconfig.snapshot.json","README.md",".gitignore"];
  const image=options.imageDir===undefined?"default":relative(directory,resolve(options.imageDir));
  const recipe=`import type { SnapshotRecipe } from "@oxidevm/sdk/image-builder";
export default {
  name: ${JSON.stringify(options.name)}, mode: ${JSON.stringify(mode)}, image: ${JSON.stringify(image)},
  workload: { module: "./prepare.ts" }, verify: { module: "./verify.ts" },
} satisfies SnapshotRecipe;
`;
  await file(directory,"oxidevm.snapshot.ts",recipe);await file(directory,"prepare.ts",preparationSource(mode));await file(directory,"verify.ts",verificationSource());
  await file(directory,"tsconfig.snapshot.json",JSON.stringify({compilerOptions:{target:"ES2024",module:"ESNext",moduleResolution:"Bundler",lib:["ES2024","DOM","DOM.Iterable"],types:[],strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,verbatimModuleSyntax:true,noEmit:true,skipLibCheck:false},include:["prepare.ts","verify.ts"]},null,2)+"\n");
  await file(directory,".gitignore","dist/\n*.pem\n*.oxvm\n*.owners/\n*.building-*/\n*.previous-*/\n*.publication.json*\n");
  await file(directory,"README.md",`# Prepared ${options.name}

The Node recipe selects inputs. Preparation and verification run in the browser and import only the public SDK; Node globals are unavailable. Workspace API paths are relative to /workspace.

Create a separate snapshot key: \`oxidevm image keygen --out snapshot-author.pem\` (public companion: snapshot-author.public.json).
Run \`oxidevm snapshot build oxidevm.snapshot.ts --signing-key snapshot-author.pem${options.imageDir===undefined?"":" --image-trust <image-author.public.json>"}\`.
Run \`oxidevm snapshot test dist --trust snapshot-author.public.json\`. Type-check browser scripts with \`tsc -p tsconfig.snapshot.json\`; check the recipe in your project's strict Node configuration.

The verifier reattaches the original shell and proves its in-memory token and PID. It never initializes that token again. Keep image key A separate from snapshot key B. Signed bundles are development-only; signing does not grant guest or engine redistribution rights.
`);
  return {directory,recipePath:join(directory,"oxidevm.snapshot.ts"),name:options.name,mode,files};
}
