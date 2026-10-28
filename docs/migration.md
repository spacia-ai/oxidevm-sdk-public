# SDK migration

## Explicit image projects

`ProjectConfig` accepts an optional `image` location, manifest SHA-256, and author
trust key. Its mode must match the project. The project lock records this exact
image and rejects later changes without an explicit project update.

Application initialization accepts `--image <bundle> --image-trust <file>`.
Both options are required together. Asset installation accepts
`--image <bundle> --trust <file>` and preserves existing project locks.

A newly installed custom image now becomes the project's image lock. Earlier
development builds could stage a custom image while locking the managed
default instead. Recreate that development lock from the explicitly selected
image before updating its assets. The installer never replaces a conflicting
existing lock silently.

Release catalog schema 3 describes a release with no managed images and no
managed kernel integration. Schema 2 remains supported for existing private
releases. A release with no configured default returns `FEATURE_NOT_AVAILABLE`
when a caller requests one. Supply an image explicitly in these releases.

## Version and runtime identity

SDK packages, CLI packages, embedded SDK version, and catalog version belong to
the same release. Update them together. The CLI archive must depend exactly on
the matching SDK version.

A hosted runtime frame also uses the SDK version in its URL and handshake.
Building a package does not deploy that hosted frame. Private qualification
serves matching assets through a browser fixture without deployment.

Project locks bind the SDK version, engine release, image, and staging paths.
Updating a dependency alone does not migrate a project lock. Select and verify
the replacement release and image before regenerating it.

Restore point formats and runtime support remain experimental. A package
version change does not establish snapshot compatibility or runtime GA.

## Hosted starter development

New starters select the hosted runtime frame in development and production.
Normal `init` writes signed image references without installing engine files or
image archives. Explicit `--engine-dir` and private operator profiles retain
local runtime staging. A local custom image alone does not select a local engine.

Existing applications can select frame hosting in `src/runtime.ts`. The pinned
hosted runtime must exist. Missing hosted assets fail without a local fallback.
This changes the storage origin. Existing local runtime workspaces remain at
their original origin and do not migrate automatically.
