# Contributing

Maintainers develop the SDK and CLI in the authoritative private source
repository. This repository receives reviewed, reproducible exports.

Submit a focused pull request with a regression test for a behavior change.
Keep public types, examples, and documentation consistent. Maintainers review
and import the change into the authoritative source, run integration checks,
then export the result with contributor credit. The original pull request
links to its exported commit if its original commit identity is not retained.

Use the pinned pnpm version and existing package scripts. Run the relevant
strict TypeScript, lint, unit, and production-build checks. Package tests must
use actual packed archives. Browser and engine tests require separately
provided, permitted artifacts.

Follow [AGENTS.md](AGENTS.md) for the approved structure and content policy.
`CLAUDE.md` is a relative symlink to that file. The versioned policy used by
`pnpm check:layout` owns the machine-checked file boundary.

Do not commit build outputs, guest images, engine binaries, credentials,
internal reports, task logs, or unrelated generated artifacts. Preserve license
notices and source provenance. Treat unsupported runtime behavior explicitly.

By submitting source, you agree to license your contribution under this
repository's Apache-2.0 license. Third-party material retains its original
license and requires its original notice.

Your submission confirms that you own it or have permission to submit it under
Apache-2.0. Identify copied or adapted material, its exact origin, revision,
license, and notices. Record provenance for generated or AI-assisted source.
Do not attribute third-party work to Spacia. Flag uncertain rights before
submission. This statement does not replace required upstream permissions.
