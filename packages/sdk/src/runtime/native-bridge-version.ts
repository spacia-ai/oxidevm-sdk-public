/**
 * The native bridge between a native Node process's JavaScript (in the SDK) and its guest host helper
 * (`/usr/local/libexec/oxidevm-node-api-host`). 16 (engine SL-S6) adds watch-signal and unwatch-signal and delivers
 * every listenable standard signal; 15 delivers only SIGHUP, SIGINT and SIGTERM. The image's acceleration profile names
 * its helper's version (`bridge\t16`); a profile without the row is 15. The SDK writes frames at that version.
 */
export type NativeBridgeVersion = 15 | 16;
export const NATIVE_BRIDGE_VERSION = 16;
