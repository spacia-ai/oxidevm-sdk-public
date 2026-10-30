# OxideVM public SDK repository instructions

## Scope and current stage

This file applies to the whole repository. `AGENTS.md` is the instruction
source. `CLAUDE.md` must be a relative symlink to `AGENTS.md`, not a second copy.

This repository is a private preparation destination for the Apache-2.0
OxideVM SDK and CLI. Keep it private until the owner explicitly authorizes
public visibility. Repository visibility and npm publication are separate
decisions. Neither follows automatically from a source export.

The starter runs Linux Python, NumPy and pandas. Its CSV calculations must run
in the Linux guest. Do not substitute JavaScript, Pyodide or remote compute.
Keep upload validation, bounded DataFrame decoding and safe text rendering.
Keep binaries outside Git and package archives. Build the pinned NumPy and
pandas sources without libquadmath, libgfortran or external BLAS. Preserve
complete source materials, selected license branches and human release gates.

The export contains the SDK, CLI, and one Python + pandas starter. Do not add extra
examples, empty directories, task reports, or redundant generated artifacts.

## Development and export ownership

- The existing private `spacia-ai/oxidevm-sdk` repository remains the
  authoritative SDK and CLI source. The separate engine repository owns the
  proprietary Rust engine, its specifications, and its releases.
- Make SDK changes, user-guide changes, tests, and operator changes in the
  authoritative SDK repository. Export a complete, qualified source revision
  through an explicit path allowlist.
- This repository receives reviewed exports. Do not develop an independent SDK
  variant here. If the owner requests a direct fix here, import it into the
  authoritative source before the next export.
- Import reviewed external contributions into the authoritative source, run
  the applicable checks, and export the result with contributor credit.
- Keep the initial public history clean. Append normal export commits after
  it. Never import source-repository history, operator branches or alpha assets.
  Reviewed export branches, version tags and SDK/CLI release archives belong here.
- Keep export rules, release credentials, and private source-to-export receipts
  in the private repository. Record the source revision, export-rule revision,
  public commit, engine identity, archive hashes, and verification there.
- Before the first source export, place the curated bootstrap files under the
  private export tooling's ownership. Preserve these instructions and the
  symlink. Never overwrite them with the private repository's agent files.
- Stop an export if its destination changed unexpectedly. Reconcile the public
  change first. Never remove another contribution with a force push.

## Approved public structure

Keep the existing SDK module ownership and paths. The approved structure is:

```text
/
  AGENTS.md
  CLAUDE.md -> AGENTS.md
  README.md
  LICENSE
  NOTICE
  CONTRIBUTING.md
  SECURITY.md
  .gitignore
  .gitleaks.toml
  .github/workflows/check.yml
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  eslint.config.ts
  playwright.config.ts
  tsconfig*.json
  packages/
    sdk/
      src/                          # Full implementation and colocated tests
      asset-source/
        preview/
        runtime-host/
        native-process/
      assets/image-catalog.json     # Public-ready metadata only
      package.json
      tsconfig*.json
      vite.*.config.ts
      vitest.core.config.ts
      LICENSE
      NOTICE
    cli/
      src/                          # Commands and colocated tests
      package.json
      tsconfig*.json
      LICENSE
      NOTICE
  examples/
    starter/                        # The only starter and CLI template source
      src/
      dev/                          # Static local preview hosting
      image/                        # Reproducible recipe; no guest binaries
      public/fonts/                 # Exact licensed brand fonts and notices
  docs/
    usage.md
    api.md
    images.md
    deployment.md
    workspace-persistence.md
    migration.md
    development.md
    js-process.md
    dependencies/
  scripts/                          # Reviewed build/check/generator closure
  tests/
    fixtures/
    release/                        # Starter browser acceptance
  types/
  config/                           # Selected build and license policies
  patches/
  spec/relay/v2.json
```

The tree describes ownership, not blanket export globs. Copy only reviewed
files and their required dependency closure. Add a top-level path or broaden
the public boundary only when the owner's task authorizes it. Update these
instructions with an approved boundary change.

The full SDK implementation belongs in `packages/sdk/src`, including private
API modules, workers, protocols, storage, and networking. A private API does
not make its source confidential. Preserve package export boundaries.

Keep `packages/sdk/src/browser-test` and its build path. The public image-test
command uses the generated `assets/qualification` files. A filename containing
"qualification" alone does not make code private operator material.

Retain the SDK-owned engine pin generator and verified release fetcher when
their dependency closure is public. Never include proprietary engine build
code or engine binaries. Keep the SDK and engine licenses distinct.

## Repository content policy

Every tracked file must serve the public SDK, CLI, examples, documentation,
tests, build, repository governance, or license requirements.

`examples/starter` is the only example and the source of the CLI template.
Its reviewed project skills are pinned to an immutable public
`spacia-ai/oxidevm-skills` revision in `agent-skills.lock.json`. Maintain the
canonical skill instructions there and regenerate the snapshot. Builds check
every content hash and bind `AGENT_SKILLS.json` to the actual SDK version.
The source example's `.claude/skills` link points to `../.agents/skills`;
scaffolding writes portable checked copies for both clients, without symlink
privileges or network access. Do not broaden this exception to private agent
configuration or unrelated hidden files.
Builds stage it into `packages/cli/dist/starter.json`. Do not maintain another
copy. The versioned repository policy admits only the three exact WOFF2 brand
fonts with SHA-256 and their license texts. It still rejects engine and guest
binaries. New versions reuse this same policy and the private export commands.

Keep the following material in the private source repository:

- operator runbooks, implementation plans, task logs, completion trackers,
  internal baselines, performance captures, audit dumps, and release receipts;
- `docs/qualification`, `docs/plans`, `docs/baselines`, and
  `docs/acceleration-status`;
- private qualification, native-oracle, experiment, deployment, registry,
  promotion, and release tooling;
- the container acceptance fixture and System lab examples;
- private `.claude`, `.codex`, `.claude-plugin`, and other agent configuration;
- private operator skills and engine-development agent instructions;
- proprietary engine source, ISA specifications, engine binaries, kernels,
  rootfs archives, guest disk images, snapshots, and staged guest artifacts;
- credentials, signing keys, download tokens, private environment files,
  personal host paths, and private default download locations.

Do not add redundant documentation, conversation summaries, scratch files,
one-off codemods, generated inventories, copied reports, or placeholder
READMEs. Do not add `.gitkeep` files. Build outputs, caches, test reports, and
package archives remain untracked.

Keep one owner for each fact. Update the existing guide or module instead of
adding a parallel explanation or implementation. Add a helper only for a real
shared responsibility. Do not introduce a wrapper, framework, or dependency
for speculative future use.

Preserve required license notices, provenance, generated identities, hashes,
and contributor attribution. Token environment-variable names and legitimate
localhost examples are not credentials. Remove actual private values and
operator-specific defaults without weakening validation.

## Public behavior and compatibility

- Preserve the shared execution core and explicit runtime modes. Never add a
  second emulator or implement Linux syscall policy in JavaScript.
- Keep browser, worker, service-worker, Node, and public SDK module graphs
  separate. Keep worker protocols versioned and validated.
- Preserve SDK module ownership. Composition roots connect owners and contain
  no reusable domain logic. Keep handwritten files near 600 lines and below
  the 1,500-line ceiling.
- Maintain strict TypeScript. Do not add `any`, unsafe assertions, suppressed
  checks, or weakened lint rules. Decode untrusted values from `unknown`.
- Keep unsupported behavior explicit through stable typed errors. Preserve
  cancellation, bounds, durability, security, and accessibility.
- Use pnpm for the workspace. Preserve the source repository's pinned
  toolchains and dependency versions when exporting them.
- Describe supported behavior accurately. Keep internal acceptance status in
  private release records. Do not imply universal compatibility.
- Change public image defaults, catalogs, examples, and their tests together.
  Full-system use requires a developer-supplied image under the approved
  distribution policy. Preserve the separate engine and guest-artifact gates.
- Remove the private local registry from public scaffolds before release.
  Never place production credentials in public build or test workflows.

## Verification and releases

For a source export, validate a fresh checkout without private credentials:

1. Install the selected workspace with its frozen lockfile.
2. Build the SDK, CLI, and selected examples.
3. Run strict type, lint, documentation, license, and focused test checks.
4. Check public package exports and installation from the packed archives.
5. Scan source, generated assets, archives, and commit metadata for secrets
   and private artifacts.
6. Run applicable engine and browser checks against permitted pinned
   artifacts. Report missing evidence explicitly.

Public fork checks run without private secrets. Export and release workflows
run only trusted, reviewed code. Never execute untrusted fork code with
private registry or production credentials.

Build release archives from the exact public commit. Keep internal candidates
on distinct prerelease versions. Do not change public registry configuration,
publish packages, or change repository visibility without the owner's
authorization.

For each release, require a reviewed export and passing CI, compiler, lint,
license, layout, secret, source/archive, browser, pinned-engine, System
preservation, and image rebuild checks. Default starter and website images use
Toybox with OpenSSL hashing, dash for scripts and mksh for interactive terminals.
Use the pinned dash build with an independent signal table. Never link the
upstream GPL signal generator or its output. Retain runtime notices, source
hashes, build configuration and linker evidence. They contain no BusyBox, Bun or pnpm. The Playground uses
Node.js and npm. Keep repository maintenance on pnpm and host-side bunx support.
New default images need fresh source inventories, image pins and browser
qualification. Preserve general copyleft and relinking checks for custom images.
An image with nested LGPL components also needs verified source and relink
materials. Reuse the image builder's distribution validator for every external
distribution, including private customer previews. Incomplete local builds
cannot qualify for distribution.

Keep initial preparation private. Public candidate metadata may set packages
public without publishing them. Public GitHub, npm, image, and runtime
publication require the owner's final approval. The private alpha stream and
its registry safeguards remain separate. Public publishing uses a protected
GitHub-hosted job, provenance, and restricted credentials. No CI waiver applies.

Record origin, revision, license, use, and shipped form before adding a
component. Inspect delivered bytes, static libraries, compiler assets, copied
code, generated code, fonts, and templates. Keep tool-only exceptions outside
shipped artifacts. Unknown licenses block release. Record an allowed OR branch
and retain every AND obligation. New licenses or distribution arrangements
need a written review. Never widen policy only to pass a check.

The SDK and engine dependencies follow the permissive policy. Separately
distributed guest programs retain their own reviewed licenses and recipient
rights. Generate notices, inventories, source mappings, and checksums from
authoritative inputs. Policy copies retain their canonical revision and hash.
Human owner and required legal reviews bind exact artifacts, policy, and test
evidence. Changed inputs invalidate approval. An agent cannot be the legal
reviewer. Keep published notices and corresponding sources permanently.

Use the immutable export commit for archives. Publish sources and notices
before dependent binaries. Verify hosted runtime/image URLs before npm.
Publish SDK before CLI, verify both quickstarts, then promote tags and the
GitHub release. Resume only when existing hashes match. Never overwrite
published bytes or force-push an export. Preserve the relative CLAUDE.md link.

Source and license downloads belong in GitHub Releases. Use an independent
`image-<id>-v<version>` source release and a `sdk-materials-v<version>` license
release. Upload complete source kits explicitly. Automatic GitHub source ZIPs
are insufficient. Keep browser-loaded assets and their required compliance
sidecars on R2. Keep corresponding sources inside the image bundle too.
Publish and verify source URLs before dependent binaries. Require immutable
releases, exact hashes, and the existing human approvals. Retain sources and
notices permanently. Preparation does not publish or change repository visibility.

The starter uses run.oxidevm.dev through the hosted iframe in development and
production. Normal scaffolding installs no local engine files or image bundle.
Self-hosting is an explicit commercial option. Keep engine and image references
pinned. A missing hosted runtime fails explicitly without a local fallback.

Every externally distributed image needs its own verified notices, sources,
build inputs, and required relink materials. This includes application demos
and retained images. Starter evidence does not cover another image. Inventory
nested packages and fonts from delivered bytes. Preserve recipient rights and
publish exact source/license bundles before dependent binaries. A development
signature or status flag grants no release approval.

A matching policy hash does not admit unknown licenses. External image checks
must validate each concluded license, its selected `OR` branch, and every
`AND` obligation. Exceptions and specific first-party grants apply only within
their recorded scope. Retain notices embedded in README files and source
headers. A missing standalone license file never permits invented attribution.
Specific proprietary grants retain their exact canonical notice and explicit
permission record. Keep proprietary engine and integration source confidential.
Corresponding-source publication covers the components that require it and the
sample code's own grant. Preserve original dual-license files in source kits.
