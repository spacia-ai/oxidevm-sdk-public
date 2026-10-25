# OxideVM public SDK repository instructions

## Scope and current stage

This file applies to the whole repository. `AGENTS.md` is the instruction
source. `CLAUDE.md` must be a relative symlink to `AGENTS.md`, not a second copy.

This repository is a private preparation destination for the Apache-2.0
OxideVM SDK and CLI. Keep it private until the owner explicitly authorizes
public visibility. Repository visibility and npm publication are separate
decisions. Neither follows automatically from a source export.

The initial commit contains only repository instructions, a README, license
notices, and ignore rules. Add the working source tree through a reviewed
export. Do not create empty directories or placeholder files to imitate it.

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
  it. Never push private history, branches, tags, or release assets here.
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
    hello-files/
    terminal/
    next-workbench/
    python-image/
    shared/
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
    browser/                        # Selected public example scenarios
    integration/                    # Public exports and packed consumers
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

Keep the following material in the private source repository:

- operator runbooks, implementation plans, task logs, completion trackers,
  internal baselines, performance captures, audit dumps, and release receipts;
- `docs/qualification`, `docs/plans`, `docs/baselines`, and
  `docs/acceleration-status`;
- private qualification, native-oracle, experiment, deployment, registry,
  promotion, and release tooling;
- the container acceptance fixture and System lab examples;
- private `.claude`, `.codex`, `.claude-plugin`, and other agent configuration;
- the SDK usage plugin until it receives a separate publication review;
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
- Keep Next.js examples marked experimental until their named acceptance
  evidence exists. Do not imply runtime GA or universal compatibility.
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

For this documentation-only bootstrap, check the exact tracked file set,
license copies, symlink target, clean diff, fresh history, and private remote.
Do not claim that SDK builds or tests ran before SDK source exists here.
