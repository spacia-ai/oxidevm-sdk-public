# OxideVM SDK

Run Linux programs in your browser. Use the TypeScript SDK to work with files,
start processes, connect terminals, and preview HTTP servers.

Start with a small application that runs Linux Python and pandas inside your browser tab.
Upload a CSV, edit Python, inspect the dataframe, and make the app your own.

## Quickstart

Use Node.js 24 or newer:

```sh
npx @oxidevm/cli@latest init app --start
```

Or use Bun:

```sh
bunx --package @oxidevm/cli@latest oxidevm init app-bun --use-bun --start
```

For a fixed release, replace `@latest` with its exact version. Generated projects pin matching SDK and CLI versions.

The creator installs dependencies and starts your local app. The browser loads
the hosted runtime and verifies the signed Python + pandas image. No engine files are
installed in your project. Open the localhost URL. Edit
the page, use the terminal, run pandas code, and keep edits across reloads.
No GitHub access, launcher, image authoring, or compiler toolchain is required.

The starter includes [Codex and Claude Code skills](docs/agent-skills.md).

Read the [starter guide](examples/starter/README.md) and
[licensing guide](docs/licensing.md). Engine and guest licenses remain separate.

## Development

Use Node.js 24 or newer and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test:unit
pnpm test:cli
```

Explore the [starter source](examples/starter/README.md) to see files,
processes, terminals and previews working together.

Read the [usage guide](docs/usage.md), [API reference](docs/api.md),
[deployment guide](docs/deployment.md), and [development guide](docs/development.md).
See [CONTRIBUTING.md](CONTRIBUTING.md) for the source and export workflow.

## License

The SDK, CLI, and sample source use the [Apache License, Version 2.0](LICENSE).
Copyright 2026 Spacia B.V. See [NOTICE](NOTICE).

Engine binaries and guest images are separate distributions with their own
licenses. Third-party notices remain attached to their components. Image
signatures authenticate bytes and do not grant redistribution rights.

See [GPL and other image sources](docs/licensing.md#image-source-downloads) for
the matching image sources, other component sources, build instructions,
licenses, and checksums. Each GitHub release includes the same direct downloads.
