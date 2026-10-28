/** Absolute ELF paths enter the native owner directly. Names and relative paths
 * use the image's real shell for PATH lookup and script/interpreter execution.
 * Positional operands never become shell source, and exec retains the process ID. */
export function nativeGuestCommand(command: string, args: readonly string[]): {
  readonly executable: string;
  readonly arguments: readonly string[];
} {
  return command.startsWith("/")
    ? { executable: command, arguments: [command, ...args] }
    : { executable: "/bin/sh", arguments: ["/bin/sh", "-c", 'executable=$(command -v -- "$1") || exit 127; shift; exec "$executable" "$@"', "oxidevm-exec", command, ...args] };
}
