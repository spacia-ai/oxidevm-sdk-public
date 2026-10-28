import type { CommandInterceptor } from "./command-interceptors.js";

/** The bundled, authenticated TypeScript 6.0.2 CLI worker. Unmatched commands stay in Linux. */
export function typescriptInterceptor(): CommandInterceptor {
  return { command: "tsc", worker: new URL("../assets/interceptors/tsc.worker.js", import.meta.url) };
}
