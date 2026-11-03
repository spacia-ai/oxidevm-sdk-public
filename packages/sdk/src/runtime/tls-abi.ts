// The engine's TLS module (engine ADR 0029, N-4 and N-7): a sans-IO TLS client on a raw ABI with no imports,
// released as `oxidevm_tls.wasm` beside the Userspace module and pinned by its `tlsApi` identity (release.json
// schema 4). Its exports are the `oxidevm_tls_*` functions of the engine's crates/oxidevm-tls/src/wasm.rs.

/** 2 adds per-session trust anchors and the peer chain, cipher suite and protocol version queries. */
export const TLS_API_VERSION = 2;

export const TLS_EXPORTS = [
  "oxidevm_tls_api_version",
  "oxidevm_tls_buffer_ptr",
  "oxidevm_tls_buffer_capacity",
  "oxidevm_tls_entropy",
  "oxidevm_tls_clock",
  "oxidevm_tls_roots_append",
  "oxidevm_tls_roots_commit",
  "oxidevm_tls_anchors_append",
  "oxidevm_tls_open",
  "oxidevm_tls_receive",
  "oxidevm_tls_send",
  "oxidevm_tls_take_tls",
  "oxidevm_tls_take_plaintext",
  "oxidevm_tls_status",
  "oxidevm_tls_alpn",
  "oxidevm_tls_peer_certificate",
  "oxidevm_tls_cipher_suite",
  "oxidevm_tls_protocol_version",
  "oxidevm_tls_close",
  "oxidevm_tls_free",
] as const;
export type TlsExport = typeof TLS_EXPORTS[number];

/**
 * What a Rust wasm32 module adds on its own: its memory, two linker globals, getrandom's custom-backend hook, and
 * ring's Montgomery multiplication (a `#[no_mangle]` Rust function its C code calls; the name carries ring's pinned
 * version). The SDK calls neither.
 */
export const TLS_LINKER_EXPORTS = [["memory", "memory"], ["__data_end", "global"], ["__heap_base", "global"], ["__getrandom_custom", "function"], ["ring_core_0_17_14__bn_mul_mont", "function"]] as const;
