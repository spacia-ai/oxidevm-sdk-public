/** Exact, reviewable changes to the authenticated upstream source and Go OS adapter. */
export function replaceOnce(source: string, before: string, after: string): string {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Pinned esbuild platform boundary changed: ${before.slice(0, 80)}`);
  return source.replace(before, after);
}

export function patchGoFilesystem(source: string): string {
  source = replaceOnce(source, '"errors"', '"errors"\n\t"strconv"');
  source = replaceOnce(source, '\tst.Ino = uint64(jsSt.Get("ino").Int())', '\tst.Ino, _ = strconv.ParseUint(jsSt.Get("ino").String(), 10, 64)');
  source = source.replace(/\tif f\.seeked \{\n\t\tn, err := P(read|write)\(fd, b, f\.pos\)\n\t\tf\.pos \+= int64\(n\)\n\t\treturn n, err\n\t\}\n/gu, "");
  source = source.replaceAll("fsCall(\"read\", fd, buf, 0, len(b), offset)", "fsCall(\"read\", fd, buf, 0, len(b), strconv.FormatInt(offset, 10))")
    .replaceAll("fsCall(\"write\", fd, buf, 0, len(b), offset)", "fsCall(\"write\", fd, buf, 0, len(b), strconv.FormatInt(offset, 10))");
  const start = source.indexOf("\tvar newPos int64\n", source.indexOf("func Seek("));
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("Go Seek boundary changed");
  source = source.slice(0, start) + `\tvalue, err := fsCall("lseek", fd, strconv.FormatInt(offset, 10), whence)
\tif err != nil { return 0, err }
\tnewPos, err := strconv.ParseInt(value.String(), 10, 64)
\tif err != nil { return 0, EOVERFLOW }
\tf.dirIdx = 0
\treturn newPos, nil` + source.slice(end);
  // File descriptors and offsets stay in Rust; Go's directory iterator stays upstream-owned.
  for (const method of ["Read", "Write"]) {
    const offset = source.indexOf(`func ${method}(`), end = source.indexOf("\n}\n", offset);
    const body = source.slice(offset, end).replace("f, err := fdToFile", "_, err := fdToFile");
    source = source.slice(0, offset) + body + source.slice(end);
  }
  source = source.replaceAll("\tf.pos += int64(n2)\n", "");
  for (const [name, field] of [["atime", "Atime"], ["mtime", "Mtime"], ["ctime", "Ctime"]] as const) {
    source = replaceOnce(source, `\t${name} := int64(jsSt.Get("${name}Ms").Int())\n\tst.${field} = ${name} / 1000\n\tst.${field}Nsec = (${name} % 1000) * 1000000`,
      `\tst.${field}, _ = strconv.ParseInt(jsSt.Get("${name}Sec").String(), 10, 64)\n\tst.${field}Nsec = int64(jsSt.Get("${name}Nsec").Int())`);
  }
  return source;
}
