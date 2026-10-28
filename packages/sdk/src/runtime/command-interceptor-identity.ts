/** Pinned compiler identity shared by the trusted worker and its build tool. */
export const TYPESCRIPT = {
  version: "6.0.2",
  entries: [
    "/workspace/node_modules/.bun/typescript@6.0.2/node_modules/typescript/bin/tsc",
    "/workspace/node_modules/.pnpm/typescript@6.0.2/node_modules/typescript/bin/tsc",
  ],
  licenseSHA256: "a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47",
  files: {
    entry: { path: "bin/tsc", sha256: "8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0", name: "entry script" },
    package: { path: "package.json", sha256: "bb6ee7e709ae60426e30b8d393df4d939ee61407794b4f053ce6338d6eaa8c63", name: "package" },
    wrapper: { path: "lib/tsc.js", sha256: "2cffde0b8c6760dfb0b5b0382bbb7e00ba6a8b2d981b9205b256a700a481d983", name: "entry wrapper" },
    compiler: { path: "lib/_tsc.js", sha256: "2cf94b017788761cff62c0f58d6fa3c299afd0c51f6576ca5786f5762b172962", name: "compiler" },
  },
} as const;
