/**
 * The native bridge between a native Node process's JavaScript (in the SDK) and its guest host helper
 * (`/usr/local/libexec/oxidevm-node-api-host`). 16 (engine SL-S6) adds watch-signal and unwatch-signal and delivers
 * every listenable standard signal; 15 delivers only SIGHUP, SIGINT and SIGTERM. The image's acceleration profile names
 * its helper's version (`bridge\t16`); a profile without the row is 15. The SDK writes frames at that version.
 * 17 (engine ADR 0026, crossed calls) adds turns: the helper asks before it runs an asynchronous completion, and
 * JavaScript grants the turn only when it is idle, so a completion never runs inside a synchronous native call.
 * 18 widens a callback identity's slot from 12 to 20 bits, so a million functions and finalizers can be alive at once
 * (every wrapped native object holds one until it is collected); earlier helpers keep 4,096.
 */
export type NativeBridgeVersion = 15 | 16 | 17 | 18;
export const NATIVE_BRIDGE_VERSION = 18;
/** The callback slots a helper of this bridge version has: an identity is `generation * slots + slot`. */
export const nativeCallbackSlots = (version: NativeBridgeVersion): number => version >= 18 ? 1 << 20 : 4096;
