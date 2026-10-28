# OxideVM SDK

Run Linux programs in your browser. Use the TypeScript SDK to work with files,
start processes, connect terminals, and preview HTTP servers.

Start with a small application that runs nginx inside your browser tab.
Edit its page, try the terminal, and make the app your own.

## Quickstart

After publication of this release, use Node.js 24 or newer:

```sh
npx @oxidevm/cli@0.0.1 init app --start
```

Or use Bun:

```sh
bunx --package @oxidevm/cli@0.0.1 oxidevm init app-bun --use-bun --start
```

The creator installs dependencies and starts your local app. The browser loads
the hosted runtime and verifies the signed nginx image. No engine files are
installed in your project. Open the localhost URL. Edit
the page, use the terminal, restart nginx, and keep edits across reloads.
No GitHub access, launcher, image authoring, or compiler toolchain is required.

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
the matching BusyBox source kit, other component sources, build instructions,
licenses, and checksums. Each GitHub release includes the same direct downloads.
