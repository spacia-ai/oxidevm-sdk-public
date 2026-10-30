# Python + pandas starter image

This independently versioned image runs CPython 3.12.15, NumPy 2.2.6 and pandas
2.3.3 as real Linux x86-64 programs. It has an empty writable workspace owned
by uid/gid 1000. The starter application seeds its example files at first use.
It includes Toybox, dash, mksh and their qualified utility closure. It contains
no Linux kernel, engine, Node.js, npm, Bun, Git, compiler or preinstalled project.

Application users receive the prebuilt signed image. These commands are for
image maintainers only. Keep signing keys outside Git and package archives.

## Locate the complete recipe

This directory belongs to the SDK source release. It is not copied into
CLI-generated applications. Start from the release-pinned recipe link in the
application README, not a newer branch. The app's `LICENSES.md` identifies the
selected image's separate source/license release. Its archives contain source
materials, not an OCI base or the required prebuilt Python rootfs.

| File | Purpose |
| --- | --- |
| `Dockerfile`, `.dockerignore` | Runtime stages and bounded build context |
| `oxidevm.image.ts` | Userspace resources, evidence paths and import smoke test |
| `inputs.lock.json`, `python-inputs.lock.json` | Exact utility, Python, NumPy and pandas inputs |
| `source-lock.json`, `components.json`, `LICENSE-SELECTIONS.md` | Source identities, component inventory and license selections |
| `prepare.ts` | Download and verify pinned inputs and the supplied Python rootfs |
| `compliance.ts`, `pandas-materials.py`, `material-inputs.ts`, `inventory.ts` | Reconcile actual files with source and license evidence |
| `build-*.sh`, `dash-signames.c`, `install-python-inputs.py`, `supplements.json` | Recorded build steps and utility inputs |
| `test-utilities.sh` | Utility behavior checks |

Use Node.js 24 or newer, the checkout's pinned pnpm, Python 3 and a working
Docker Buildx/BuildKit Linux x86-64 builder. From the SDK checkout root, install
with `pnpm install --frozen-lockfile` and run `pnpm build` before running the
preparation scripts. Do not copy only the Dockerfile into a generated app.
The recipe depends on the complete sibling scripts and locks.

Supply these inputs outside Git before preparation:

| Variable | Required input |
| --- | --- |
| `OXIDEVM_PANDAS_BASE_ROOTFS` | Exact rootfs archive named and hashed in `python-inputs.lock.json` |
| `OXIDEVM_PANDAS_BASE_BUNDLE` | Complete signed, distribution-qualified base bundle matching that lock's manifest digest |
| `OXIDEVM_PANDAS_BASE_TRUST` | Independently retained base-author public trust file |
| `OXIDEVM_IMAGE_SIGNING_KEY` | Your own external private key, only when creating a signed development bundle |

Do not replace missing inputs with similarly named files or skip the checks.
If the exact base is unavailable, this particular rebuild is blocked. Use the
[custom-image guide](../../../docs/images.md) to create an author-owned image
from independently pinned inputs instead. It also explains signing, browser
tests, image-only staging with the hosted runtime, production configuration and
distribution checks. Keep the application's engine hosted unless explicit
licensed self-hosting is requested.

## Build from recorded inputs

`python-inputs.lock.json` pins the independently qualified Python base archive,
all Python package sources, wheel inputs, headers and native build tools.
`inputs.lock.json` pins the separate utility build inputs. NumPy and pandas
compile from source with `-O2 -march=x86-64-v2`. NumPy uses `blas=none`,
`lapack=none`, SSE2 baseline and no CPU dispatch. Its internal BLAS/LAPACK
fallback suits this small CSV demo. No broad numerical performance claim is made.
The image rejects libquadmath, libgfortran and OpenBLAS. The compiler and Python
build tools stay outside the final image. GCC runtime libraries retain their
explicit Runtime Library Exception and original source materials.

Supply the exact qualified base archive through `OXIDEVM_PANDAS_BASE_ROOTFS`.
Supply its signed bundle and independent trust file through
`OXIDEVM_PANDAS_BASE_BUNDLE` and `OXIDEVM_PANDAS_BASE_TRUST`. Preparation rejects
changed base identities and archives. The base's component sources retain their
upstream archives, Alpine recipes, patches, build inputs and notices.

```sh
node examples/starter/image/prepare.ts
node examples/starter/image/compliance.ts
```

Preparation downloads and hash-checks the recorded inputs. Compliance writes
`.cache/candidate/rootfs`, `evidence/` and `recipe.json`. If
`OXIDEVM_IMAGE_SIGNING_KEY` is set, it also writes a development `bundle/` and
`RESULT.json`. These paths are relative to this recipe directory. Each candidate
needs a fresh output directory; retain previous evidence separately before
rebuilding. The original published recipe and image identities remain immutable.
For a changed image, select your own ID/version and update all affected pins,
component mappings, source materials and smoke tests before qualification.

The compliance command captures the actual final rootfs. It compares unchanged
files against the authenticated base inventory. It verifies new GCC library
bytes against the pinned APK payloads. It maps new Python files to the pinned
source builds. Unknown files fail. SPDX, CycloneDX, notices, source mappings,
license texts and checksums come from that same inventory.

Set `OXIDEVM_IMAGE_SIGNING_KEY` to prepare a signed development bundle in the
private candidate directory. A development bundle cannot pass distribution
checks. Distribution requires the existing image builder's independent rebuild,
complete material validation, browser checks, and separate human reviews.
Do not reuse approval for the previous nginx image.

Keep binary archives, build caches and signed bundles outside Git and SDK/CLI
archives. Never overwrite a published image digest. The image version is
independent of the SDK version. Private preview replacement does not change
normal release immutability rules.

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
