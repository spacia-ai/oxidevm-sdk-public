# Large-message Ed25519 verification

`@noble/curves` 2.0.1 is an MIT dependency used only for the existing Ed25519
signature contract. Its exact package and integrity digest are pinned in
`pnpm-lock.yaml`; it reuses the SDK's existing `@noble/hashes` 2.0.1 dependency.
No license allowlist changes are needed.

The Linux WebKit 26.5 renderer crashed during native Ed25519 verification of a
100,000-byte message signed with Node's Ed25519 implementation. A standalone
page reproduced the crash without OxideVM, while a 48-byte message verified.
The private parity rootfs manifest is larger than this limit.
[WebKit's implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/crypto/gcrypt/CryptoAlgorithmEd25519GCrypt.cpp)
places the complete message in a libgcrypt S-expression;
[libgcrypt's source](https://github.com/gpg/libgcrypt/blob/master/src/sexp.c)
documents its 65,535-byte atom limit. Reproduction logs are retained in the
engine checkout's `.cache/linux-user-parity-browser-libs-20261015/`.

`runtime/ed25519.ts` keeps native WebCrypto for messages up to 32 KiB and uses
the Ed25519 module above that conservative boundary. Verification uses
`zip215: false`, the library's strict RFC 8032 mode. It checks the original
message and signature; it does not alter canonicalization, sign a different
digest, accept weaker keys, or bypass authentication. This size rule applies
uniformly across engines and uses no browser identity detection.

[Upstream documentation](https://github.com/paulmillr/noble-curves/tree/2.0.1)
describes the implementation, verification criteria, cross-library tests and
security history. Only the Ed25519 module is imported, statically so classic
IIFE worker bundles remain supported without code splitting. Verification is
isolated from hot guest execution and runs only when a signed payload
requires it. A real Vite worker-bundling regression failed with the former
dynamic import and passes with the static import. Colocated regressions verify valid large messages, changed
payloads and keys, the native boundary, and rejection of small-order identity
keys that permissive ZIP215 verification would admit.
