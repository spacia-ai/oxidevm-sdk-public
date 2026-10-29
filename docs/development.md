# Development and archive installation

Use Node.js 24 or newer, pnpm 11.17.0, Go 1.26.8 and OpenSSL. Go builds the
qualified browser compiler asset. It does not build the OxideVM engine.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm secrets:check
pnpm test:unit
pnpm test:cli
pnpm test:scripts
pnpm test:packed
```

`check` runs the versioned layout policy, strict compiler projects, typed
documentation examples, type-aware lint and license checks. `test:packed`
installs the actual SDK and CLI archives in a fresh consumer. It verifies
declarations, package exports, exact versions, CLI image initialization and
the starter build, fonts, and canonical CLI template.

The SDK contains a required esbuild compiler Wasm asset. It contains no
OxideVM engine or guest binaries. The pinned engine is a separate artifact.
For applicable worker/engine compatibility tests:

```sh
pnpm engine:fetch --print-dir
OXIDEVM_ENGINE_DIR=/absolute/path/to/verified/engine pnpm test:core
```

Builds do not prove browser behavior. Browser tests need separately signed
images and an HTTPS or loopback host with isolation headers. See
[deployment](deployment.md) and [images](images.md). System images are supplied
by the developer.

Stage the signed Python + pandas image and pinned engine with the starter. Start its
Vite server, then run `OXIDEVM_STARTER_URL=http://127.0.0.1:5173 pnpm test:browser`.
The browser test verifies real Linux Python and native NumPy/pandas extensions,
CSV upload and export, editing, cancellation, persistence, reset and terminal input. Images and private
qualification reports stay outside Git. `pnpm test:starter` runs the focused
DataFrame validation, executable-identity and preview-host tests without an image.

## Install both archives

Download both archives and `SHA256SUMS` from the same GitHub release.
Verify their checksums before installation. Add these entries to the consumer's
`pnpm-workspace.yaml`, using absolute paths and the actual version:

```yaml
packages:
  - .
overrides:
  '@oxidevm/sdk': file:/absolute/path/oxidevm-sdk-0.0.2.tgz
allowBuilds:
  esbuild: true
```

```sh
pnpm add /absolute/path/oxidevm-sdk-0.0.2.tgz
pnpm add -D /absolute/path/oxidevm-cli-0.0.2.tgz
pnpm exec oxidevm --version
```

The override ensures that the CLI resolves the supplied SDK archive. Do not
mix archives from different releases. Public packages also install from npm.

## Create a starter

Use the public npm package:

```sh
npx @oxidevm/cli@latest init data-starter --start
```

Or use Bun:

```sh
bunx --package @oxidevm/cli@latest oxidevm init data-starter-bun --use-bun --start
```

For a fixed release, replace `@latest` with an exact version such as `0.0.2`.
The generated project pins matching SDK and CLI versions.

Use a new directory name for each test. The creator preserves existing files.
Open the printed localhost URL. Development and production use the hosted
iframe. Neither initialization nor the application build downloads engine
binaries into the project.

The starter runs Linux Python and pandas. Upload a CSV, edit `analysis.py`,
and inspect or export `result`. The first Python import can take time.

Explicit local image bundles and licensed self-hosting remain available for
advanced consumers. They are optional and do not form part of the quickstart.

## Continuous integration

Source checks use self-hosted runners. Fork contributions must be reviewed and
imported into a repository-owned export branch before checks. Publication uses
GitHub-hosted runners for npm provenance and trusted publishing. Publication
credentials are restricted to the protected release environment.
