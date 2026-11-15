import type {CliCommand} from "./contracts.js";
export const snapshotHelp=`
  snapshot init [directory] [--name ready] [--mode userspace|system] [--image <bundle>] [--image-trust <A.public.json>]
  snapshot build [recipe] [--signing-key <B.pem>] [--image-trust <A.public.json>] [--out <directory>] [--base-url <url>]
  snapshot pack <backup.oxvm> [--recipe <recipe>] [--signing-key <B.pem>] [--image-trust <A.public.json>] [--out <directory>] [--base-url <url>]
  snapshot test <bundle> [--trust <B.public.json>] [--verify <module>]
  snapshot inspect <bundle-or-backup> [--trust <B.public.json>]

Build, pack and test accept --browser chromium|firefox|webkit, --timeout-ms <milliseconds>, --engine-dir <release> and --json.
Init and inspect accept --json. Signing uses OXVM_SIGNING_KEY_FILE; image trust uses OXVM_IMAGE_TRUST_FILE;
snapshot trust uses OXVM_SNAPSHOT_TRUST_FILE. Legacy OXIDEVM_* names remain accepted; conflicting values are refused. A recipe's imageTrust takes precedence over that environment default.
The default init directory is snapshots/ready; build and pack use oxvm.snapshot.ts (or legacy oxidevm.snapshot.ts) by default.
Signing does not grant guest redistribution rights; snapshot bundles are development-only.
`;
export function snapshotCommandHelp(command:CliCommand):string {return `oxvm ${command}\n${snapshotHelp}`;}
