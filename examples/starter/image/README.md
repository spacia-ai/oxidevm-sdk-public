# nginx starter image

This independently versioned image recipe contains nginx 1.30.6-r0,
Toybox 0.8.15, dash 0.5.13.5, mksh R59c, musl 1.2.6-r2, pcre2 10.49-r0, OpenSSL 3.5.7-r0 and
zlib 1.3.2-r0 from the pinned Alpine 3.24.2 image and package repositories.
The utility closure also contains XZ 5.8.4, libarchive 3.8.10's ZIP extractor,
Gavin Howard dc 7.0.3, Dropbear 2026.94 and curl 8.23.0.
The final stage copies only their runtime closure, certificates and account files. Its empty
workspace belongs to uid/gid 1000. It has no kernel, JavaScript runtime,
package manager, Git, project, package cache or acceleration artifact.

```sh
node examples/starter/image/prepare.ts
pnpm exec oxidevm image keygen --out /absolute/private/author.pem
pnpm exec oxidevm image build examples/starter/image/oxidevm.image.ts --signing-key /absolute/private/author.pem
pnpm exec oxidevm image test examples/starter/image/dist --trust /absolute/private/author.public.json --engine-dir /absolute/pinned-engine
```

`prepare.ts` verifies every download against `inputs.lock.json`. The Docker
build uses those inputs offline. It compiles Toybox from its exact source and
builds dash with an independent signal table, and copies mksh from its pinned Alpine package. Build tools stay in the build
stage. `build-supplements.sh` builds only the missing utilities from hashed
upstream archives. `supplements.json` owns their file and license mappings,
including the libraries linked into Dropbear and unzip. musl, OpenSSL and zlib come from the immutable base image. Their exact
versions remain in the final SBOM.

Keep the signed bundle, private signing key and qualification reports outside
Git and SDK/CLI archives. The author trust file must arrive independently.
Reuse the image by immutable manifest digest. Bump its own version when its
inputs change; it does not follow the SDK package version.

Local builds without `--distribution` remain incomplete development bundles.
Generate exact materials with `node examples/starter/image/compliance.ts`,
then build a separate output with `--distribution`. Distribution remains blocked until
the image builder accepts the complete SBOM, notices, exact corresponding
sources, technical license policy, two matching builds and browser evidence.
External distribution also requires the human owner and legal gates.
Pinned package versions alone are not reproduction evidence or legal approval.

Toybox uses 0BSD. mksh uses MirOS AND Unicode-DFS-2016. Preserve their
complete original notices and the supplied source/configuration/build inputs.
This default image contains no BusyBox or Bun. Historical and custom copyleft
images retain all corresponding-source and relinking obligations.
Record package provenance, source checksums, build revisions and licenses for
nginx, musl, pcre2, OpenSSL and zlib too.

nginx uses its normal foreground, single-process development configuration.
It listens on unprivileged port 8080. Temporary files live under `/tmp`; its
configuration and access log live under `/workspace`. The SDK watches that
log for actual HTTP status. Reads are bounded at 64 KiB; when the log exceeds
that limit the interface shows status unavailable until nginx restarts.

## Utility coverage

| Function | Supplied implementation | Additional package needed |
| --- | --- | --- |
| POSIX scripting shell | dash with independent signal table | BSD-3-Clause AND Apache-2.0 |
| Interactive terminal shell | mksh | History, completion and job control |
| awk, tr, expr, bc | Toybox | None |
| cron and crontab | Toybox crond and crontab | None |
| getty, last, mount and Linux utilities | Toybox | None |
| gzip and gunzip | Toybox | No pigz |
| xz and unxz | XZ core | 0BSD core only |
| ZIP extraction | libarchive bsdunzip | BSD-2-Clause AND BSD-3-Clause AND CC0-1.0 |
| TAR extraction | Toybox tar | None |
| diff and cmp | Toybox | No uutils |
| vi | Toybox | No nvi2 |
| dc | Gavin Howard dc | BSD-2-Clause |
| SSH client and server | Dropbear | MIT AND BSD-2-Clause AND SSH-short |
| HTTP and HTTPS downloads | curl | curl license |

Some Toybox applets are upstream pending commands. The complete enabled
configuration and command list accompany the sources. Test actual workloads
before adding claims. This is not a complete GNU coreutils compatibility promise.
The scripting shell `/bin/sh` links to dash. Interactive terminals explicitly select mksh and fall back to the image's `/bin/sh` for custom images. Keep these roles separate. Do not add other shell alternatives. sbase does not supply every calculator
or cron function in common replacement lists. Check the pinned sources.

XZ excludes its GPL helper scripts and uses musl's native getopt_long.
Dropbear uses the WTFPL branch for LibTomCrypt and Unlicense for LibTomMath.
Both linked libraries appear separately in the inventory and source mappings.
SSH does not start automatically and no host keys or credentials are shipped.
The Mozilla certificate collection retains MPL-2.0 AND MIT. Browser network,
privilege and runtime limitations still apply to these Linux programs.

The source-built executables also contain GCC 15.2.0-r5 runtime objects
(GPL-3.0-or-later WITH GCC-exception-3.1) and musl 1.2.6-r3 startup objects
(MIT). These appear as separate inventory entries with exact sources, Alpine
recipes and complete license texts. They are not the build-only GCC compiler.
The exception is recorded explicitly. Human review must confirm its conditions.

The image configures OxideVM virtual DNS at `192.0.2.1`. Verify DNS and HTTPS through the enabled browser network path. Keep this configuration when selecting or rebuilding the runtime closure.

## Hashing and scripting builds

Toybox enables its existing OpenSSL hashing path. Its effective `OPTIMIZE`
setting is `-O2`, checked in the generated compiler command. `CFLAGS=-O2`
alone is insufficient because Toybox appends its own optimization setting.
OpenSSL retains Apache-2.0 and its exact library source materials.

Dash 0.5.13.5 supplies `/bin/sh` for scripts. The upstream archive includes
`src/mksignames.c` under GPL-2.0-or-later, and upstream links its output.
`build-dash.sh` removes both that generator and any pre-generated output
before configuration. It uses the independently authored Apache-2.0
`dash-signames.c` constant table for Linux x86-64 musl instead. The build checks
that ABI, signal behavior, source headers, table identity and linker inputs.
The shipped dash runtime retains BSD-3-Clause AND Apache-2.0. The source kit
keeps the complete unmodified upstream archive, original COPYING, replacement
source, build script, runtime notices, source checksums, configuration and link
map. Build-only licenses remain in the source kit. They are not runtime grants.
The image's GCC runtime exception and certificate-data obligations still apply.

Measure the exact commands in Chromium on the pinned engine before changing
compiler flags or shell defaults. Compare the portable SHA round-copy fix,
OpenSSL, `-O2` and `-O3` using actual compiler commands and binary hashes.
Keep alternative binaries and BusyBox reference measurements private. Ship
only the selected implementation. Retain one warm-up and five alternating
samples, correct output and browser wall time. Guest `time` is a virtual clock.
