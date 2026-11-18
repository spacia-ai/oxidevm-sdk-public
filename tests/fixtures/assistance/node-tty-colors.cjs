"use strict";
// Records tty.WriteStream.prototype.getColorDepth and hasColors on the pinned Node.js 24.18.1 for
// packages/sdk/src/runtime/workers/native-node-api/tty-colors.ts; its output is node-tty-colors.controls.json.
// Run with the runtime row of the engine's spec/acceleration/artifacts.tsv, through its own musl loader:
//   <root>/lib/ld-musl-x86_64.so.1 --library-path <root>/lib:<root>/usr/lib <root>/usr/bin/node node-tty-colors.cjs
const { WriteStream } = require("node:tty");
const prototype = WriteStream.prototype;
const environments = [
  {}, { FORCE_COLOR: "" }, { FORCE_COLOR: "0" }, { FORCE_COLOR: "1" }, { FORCE_COLOR: "true" }, { FORCE_COLOR: "2" }, { FORCE_COLOR: "3" },
  { FORCE_COLOR: "4" }, { FORCE_COLOR: "false" }, { NO_COLOR: "" }, { NO_COLOR: "1" }, { NODE_DISABLE_COLORS: "1" }, { TERM: "dumb" },
  { TERM: "dumb", FORCE_COLOR: "1" }, { NO_COLOR: "1", FORCE_COLOR: "1" }, { TMUX: "1" }, { CI: "true" }, { CI: "1", GITHUB_ACTIONS: "true" },
  { CI: "1", GITLAB_CI: "1" }, { CI: "1", TRAVIS: "1" }, { CI: "1", CIRCLECI: "1" }, { CI: "1", BUILDKITE: "1" }, { CI: "1", APPVEYOR: "1" },
  { CI: "1", DRONE: "1" }, { CI: "1", GITEA_ACTIONS: "1" }, { CI: "1", CI_NAME: "codeship" }, { CI: "1", TEAMCITY_VERSION: "2020.1" },
  { TEAMCITY_VERSION: "9.1.0" }, { TEAMCITY_VERSION: "9.0.0" }, { TEAMCITY_VERSION: "10.0" }, { TEAMCITY_VERSION: "8.1" },
  { TERM_PROGRAM: "iTerm.app" }, { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "2.9" }, { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.4" },
  { TERM_PROGRAM: "HyperTerm" }, { TERM_PROGRAM: "MacTerm" }, { TERM_PROGRAM: "Apple_Terminal" }, { TERM_PROGRAM: "vscode" },
  { COLORTERM: "truecolor" }, { COLORTERM: "24bit" }, { COLORTERM: "yes" }, { TERM: "xterm-truecolor" }, { TERM: "xterm-256color" },
  { TERM: "xterm" }, { TERM: "XTERM" }, { TERM: "screen" }, { TERM: "screen-256color" }, { TERM: "linux" }, { TERM: "ansi" }, { TERM: "vt100" },
  { TERM: "vt220" }, { TERM: "rxvt" }, { TERM: "rxvt-unicode-24bit" }, { TERM: "con80x25" }, { TERM: "cons25" }, { TERM: "eterm" },
  { TERM: "konsole" }, { TERM: "mosh" }, { TERM: "putty" }, { TERM: "st" }, { TERM: "terminator" }, { TERM: "xterm-kitty" }, { TERM: "alacritty" },
  { TERM: "foot-direct" }, { TERM: "unknown" }, { TERM: "xterm", COLORTERM: "truecolor" }, { TERM: "unknown", COLORTERM: "1" },
];
const warnings = [];
process.on("warning", warning => warnings.push([warning.name, warning.message]));
const rows = environments.map(env => {
  const row = { env, depth: prototype.getColorDepth(env) };
  for (const count of [2, 16, 256, 16777216, 16777217]) row[`has${count}`] = prototype.hasColors(count, env);
  row.hasDefault = prototype.hasColors(env);
  return row;
});
const errors = [];
for (const [label, args] of [["string", ["16"]], ["one", [1]], ["fraction", [2.5]], ["negative", [-1]], ["nan", [NaN]], ["null", [null]]]) {
  try { errors.push({ label, result: prototype.hasColors(...args, {}) }); } catch (error) { errors.push({ label, error: { name: error.name, code: error.code ?? null, message: error.message } }); }
}
setImmediate(() => {
  process.stdout.write(`${JSON.stringify({ shape: { getColorDepth: [prototype.getColorDepth.name, prototype.getColorDepth.length], hasColors: [prototype.hasColors.name, prototype.hasColors.length], enumerable: Object.keys(prototype).includes("hasColors") },
    rows, errors, warnings, processDefault: prototype.getColorDepth() }, null, 2)}\n`);
});
