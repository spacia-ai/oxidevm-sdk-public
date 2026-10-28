import { exactKeys, protocolError, record, string } from "./decode.js";

export type ManagedRuntimes = ({
  readonly node: string;
  readonly bun: string;
  readonly next: string;
} & ({ readonly alpine: string } | { readonly debian: string; readonly glibc: string }))
  | { readonly kind: "custom"; readonly versions: Readonly<Record<string, string>>;
      readonly node?: never; readonly bun?: never; readonly next?: never;
      readonly alpine?: never; readonly debian?: never; readonly glibc?: never };

export function decodeManagedRuntimes(value: unknown): ManagedRuntimes {
  const source = record(value, "managed runtimes");
  if (source["kind"] === "custom") {
    exactKeys(source, ["kind", "versions"]);
    const versions = record(source["versions"], "custom runtime versions");
    const output: Record<string, string> = {};
    if (Object.keys(versions).length > 256) throw protocolError("too many custom runtimes");
    for (const [name, value] of Object.entries(versions)) {
      const version = string(value, `runtime ${name}`);
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name) || version.length === 0 || version.length > 128 || version.includes("\0")) throw protocolError("invalid custom runtime identity");
      output[name] = version;
    }
    return { kind: "custom", versions: output };
  }
  const debian = "debian" in source;
  exactKeys(source, [...(debian ? ["debian", "glibc"] : ["alpine"]), "node", "bun", "next"]);
  const version = (name: string): string => {
    const result = string(source[name], `runtime ${name}`);
    if (result.length === 0 || result.length > 128 || result.includes("\0")) throw protocolError(`invalid runtime ${name}`);
    return result;
  };
  return { ...(debian ? { debian: version("debian"), glibc: version("glibc") } : { alpine: version("alpine") }),
    node: version("node"), bun: version("bun"), next: version("next") };
}
