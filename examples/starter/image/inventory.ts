/** Source ownership captured before the minimal final image drops the APK database. */
export interface ApkPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly origin: string;
  readonly revision: string;
  readonly files: readonly string[];
  /** Original APK database checksums. The signed image SHA-256 remains the content authority. */
  readonly fileChecksums: ReadonlyMap<string, string>;
}

export function decodeApkInventory(value: unknown): readonly ApkPackage[] {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 16 * 1024 ** 2) throw new Error("Invalid APK inventory size");
  const names = new Set<string>();
  return value.trim().split(/\n\s*\n/u).map(block => {
    const fields = new Map<string, string>(), files: string[] = [], fileChecksums = new Map<string, string>();
    let directory = "", currentFile: string | undefined;
    for (const line of block.split("\n")) {
      const key = line.slice(0, 1), text = line.slice(2);
      if (line[1] !== ":") throw new Error("Invalid APK inventory line");
      if (["P", "V", "L", "o", "c"].includes(key)) {
        if (fields.has(key) || text.length === 0) throw new Error("Invalid or duplicate APK package field");
        fields.set(key, text);
      }
      if (key === "F") { directory = text; currentFile = undefined; }
      if (key === "R") {
        const path = directory === "" ? text : `${directory}/${text}`;
        if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => ["", ".", ".."].includes(part)) || Array.from(path).some(char => char.charCodeAt(0) < 32)) throw new Error("Invalid APK file path");
        if (files.includes(path)) throw new Error("Duplicate APK file path");
        files.push(path); currentFile = path;
      }
      if (key === "Z") {
        const decoded = Buffer.from(text.slice(2), "base64");
        if (currentFile === undefined || fileChecksums.has(currentFile) || !text.startsWith("Q1") || decoded.length !== 20 || decoded.toString("base64") !== text.slice(2)) throw new Error("Invalid or duplicate APK file checksum");
        fileChecksums.set(currentFile, text);
      }
    }
    const field = (key: string): string => { const text = fields.get(key); if (text === undefined) throw new Error(`Missing APK ${key}`); return text; };
    const name = field("P"), revision = field("c");
    if (names.has(name)) throw new Error("Duplicate APK package");
    names.add(name);
    if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("APK build revision must be immutable");
    return { name, version: field("V"), license: field("L"), origin: field("o"), revision, files, fileChecksums };
  });
}

export function imageFileOwner(packages: readonly ApkPackage[], path: string): ApkPackage {
  const owners = packages.filter(pkg => pkg.files.includes(path));
  const owner = owners[0];
  if (owners.length !== 1 || owner === undefined) throw new Error(`Image file ${path} requires exactly one APK owner`);
  return owner;
}
