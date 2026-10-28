import { VMError } from "../../errors.js";

export function restrictProcessControls(globals: object): void {
  const denied = () => { throw new VMError("FEATURE_NOT_AVAILABLE", "Native worker transport and termination are private to the process owner"); };
  let scope: object | null = globals;
  while (scope !== null) {
    for (const name of ["postMessage", "close"]) {
      if (Object.getOwnPropertyDescriptor(scope, name) === undefined) continue;
      // Also replace prototype methods: shadowing only the global property
      // would leave an application-callable, unaccounted transport bypass.
      Object.defineProperty(scope, name, { value: denied, writable: false, configurable: false });
    }
    const parent: unknown = Object.getPrototypeOf(scope);
    if (parent !== null && typeof parent !== "object") throw new TypeError("Invalid process global prototype");
    scope = parent;
  }
}
