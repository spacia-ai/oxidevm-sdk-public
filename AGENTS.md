# OxideVM SDK contributor instructions

This repository contains the Apache-2.0 SDK, CLI, and Python + pandas starter.
The engine has separate license terms. Guest programs retain their own licenses.
Read CONTRIBUTING.md and docs/licensing.md before changing dependencies.

## Source and structure

- Keep the public package exports and explicit runtime modes stable.
- Keep `examples/starter` as the only starter and CLI template source.
- Keep `CLAUDE.md` as a relative symlink to `AGENTS.md`.
- Follow the file policy in `config/public-repository.json`.
- Keep build outputs, archives, reports, caches, credentials, and engine binaries
  outside Git. Required compiler assets have separate reviewed build inputs.
- Keep source and license bundles in immutable GitHub Releases.
- Preserve published tags, notices, corresponding sources, and asset hashes.
- Use one owner for each fact. Update existing guides instead of adding summaries.

## Code and verification

Use strict TypeScript and pnpm. Decode untrusted values from `unknown`.
Do not add `any`, suppressed checks, or unsafe assertions.
Keep worker, browser, and Node module graphs separate.
Keep unsupported behavior explicit through typed errors.
Preserve cancellation, bounds, durability, accessibility, and security checks.

Run the frozen installation, production build, strict compiler projects,
type-aware lint, license checks, layout checks, secret checks, and relevant tests.
Test packed packages when package exports or templates change.

The starter loads the pinned hosted runtime through `run.oxidevm.dev` in both
local development and production. Local engine delivery requires explicit
licensed self-hosting. Do not add a silent local fallback.

## Dependencies and licenses

Record the exact origin, revision, license, intended use, and delivered form
before adding a component. Inspect delivered bytes, including nested libraries,
compiler runtimes, copied code, fonts, templates, and generated code.
Unknown or conflicting licenses block release.

SDK dependencies follow the permissive license policy. Separately distributed
images retain their component licenses and recipient rights. Preserve each
`AND` obligation and record the selected permitted `OR` branch. Do not widen
license policy merely to pass a check. New obligations require recorded review.

Keep the source inventories, notices, build inputs, source mappings, checksums,
and required relink materials tied to the exact delivered bytes. Retain sources
and notices permanently. Never describe an image as wholly Apache-2.0.

## CI and publication

Maintainers run CI and publication from separate private infrastructure.
This repository must contain no CI workflows, publication scripts, publication
credentials, infrastructure account identifiers, private source checkouts, or
operational reports. Consumer tests, archive validation, and reproducible image
recipes remain available. Maintainers require owner approval before publishing.

Publish source and license materials before dependent binaries. Verify the
runtime and image URLs before npm publication. Publish the SDK before the CLI.
Test both public quickstarts. Resume only when existing hashes match.
Never overwrite published bytes or force-push another contribution.
