import type { InstallationGatewayLockfile } from "../../protocol/assistance-installation-profile.js";
import type { RegistryFetchPolicy, RegistryGatewayPolicy } from "../../protocol/system-network.js";
import { lockedPackageVersions } from "./pnpm-lockfile-versions.js";

const LOCKFILE = "pnpm-lock.yaml";
const WORKSPACE = "/workspace";
const DETAIL_BYTES = 256;

/** The gateway policy for one installation and how it was reached. A frozen
 * install cannot resolve, so its registry gateway may serve each locked
 * package pruned to what pnpm's supply-chain checks read; the lockfile beside
 * the project, else the workspace root's, names those versions. Without a
 * readable lockfile (or a lockfile reader) every document stays verbatim: the
 * install then only pays the full metadata cost, never a different result.
 * The outcome is recorded in the installation profile, never inferred.
 *
 * `options.cwd` is the installer's guest-absolute directory under the
 * workspace root; the agent's file service addresses the workspace itself (a
 * leading slash is the workspace root), so each candidate is read in that
 * relative form and recorded as the guest path pnpm sees. */
export async function installationGatewayPolicy(policy: RegistryFetchPolicy,
  options: { readonly cwd: string; readonly frozenLockfile: boolean },
  readFile: ((workspacePath: string) => Promise<Uint8Array>) | undefined,
): Promise<{ readonly policy: RegistryGatewayPolicy; readonly lockfile: InstallationGatewayLockfile }> {
  const verbatim = (reason: Extract<InstallationGatewayLockfile, { kind: "verbatim" }>["reason"], detail: unknown = null) =>
    ({ policy, lockfile: { kind: "verbatim" as const, reason, detail: detail === null ? null : failureText(detail) } });
  if (!options.frozenLockfile) return verbatim("not-frozen");
  if (readFile === undefined) return verbatim("no-reader");
  const project = workspaceRelative(options.cwd);
  if (project === undefined) return verbatim("outside-workspace");
  const candidates = [`${project}/${LOCKFILE}`];
  if (project !== "") candidates.push(`/${LOCKFILE}`);
  let failure: unknown = null;
  for (const relative of candidates) {
    let bytes: Uint8Array;
    try { bytes = await readFile(relative); } catch (error: unknown) { failure = error; continue; }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return verbatim("invalid-utf8"); }
    let frozenVersions: Readonly<Record<string, readonly string[]>>;
    try { frozenVersions = lockedPackageVersions(text); } catch (error: unknown) { return verbatim("invalid-lockfile", error); }
    const packages = Object.keys(frozenVersions).length;
    if (packages === 0) return verbatim("no-packages");
    return { policy: { ...policy, frozenVersions }, lockfile: { kind: "frozen", path: `${WORKSPACE}${relative}`, packages } };
  }
  return verbatim("unreadable", failure);
}

/** The workspace-relative form of a guest-absolute directory under the
 * workspace root: "" for the root itself, "/app" for /workspace/app, and
 * undefined for a directory the workspace does not contain. */
function workspaceRelative(cwd: string): string | undefined {
  const trimmed = cwd.replace(/\/+$/u, "");
  if (trimmed === WORKSPACE) return "";
  return trimmed.startsWith(`${WORKSPACE}/`) ? trimmed.slice(WORKSPACE.length) : undefined;
}

/** A bounded, secret-free description of a read or parse failure. */
function failureText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown failure";
  return text.length > DETAIL_BYTES ? text.slice(0, DETAIL_BYTES) : text;
}
