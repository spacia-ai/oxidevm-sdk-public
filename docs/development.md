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

Stage the signed nginx image and pinned engine with the starter. Start its
Vite server, then run `OXIDEVM_STARTER_URL=http://127.0.0.1:5173 pnpm test:browser`.
The browser test verifies actual nginx HTTP content, editing, stop/start,
persistence, reset confirmation and terminal input. Images and private
qualification reports stay outside Git. `pnpm test:starter` runs the focused
server-record, executable-identity and preview-host tests without an image.

## Install both archives

Download both archives and `SHA256SUMS` from the same private GitHub prerelease.
Verify their checksums before installation. Add these entries to the consumer's
`pnpm-workspace.yaml`, using absolute paths and the actual version:

```yaml
packages:
  - .
overrides:
  '@oxidevm/sdk': file:/absolute/path/oxidevm-sdk-0.0.1.tgz
allowBuilds:
  esbuild: true
```

```sh
pnpm add /absolute/path/oxidevm-sdk-0.0.1.tgz
pnpm add -D /absolute/path/oxidevm-cli-0.0.1.tgz
pnpm exec oxidevm --version
```

The override ensures that the CLI resolves the supplied SDK archive. Do not
map this release to a registry. Both packages remain `private: true`.

## Run the prepared starter

Application users receive a prepared private preview containing the packages,
prebuilt signed image, trusted author key and pinned engine. Its launcher has
a private distribution profile. From that directory, use:

```sh
npx --no-install oxidevm init app --start
bunx --no-install oxidevm init app-bun --use-bun --start
```

The creator reads the profile, checks the exact SDK version and image trust,
and stages the prebuilt runtime. It uses the supplied archive override for
host dependencies. Image building and signing remain release-operator work.

Explicit `--mode`, `--image`, `--image-trust`, `--engine-dir`, `--sdk-archive`
and `--cli-archive` options remain available for custom integrations. They are
advanced inputs, not the starter quickstart. SDK runtime options continue to
use explicit mode discriminants.
