import { VMError } from "../../errors.ts";

function unsupported(name: string): () => never {
  return () => { throw new VMError("FEATURE_NOT_AVAILABLE", `inspector.${name} is not supported in the assisted process`, { builtin: "inspector", export: name }); };
}

/** The `inspector` builtin: no inspector is ever attached to an assisted
 * process, so `url()` answers undefined as Node does without `--inspect`, and
 * opening one or creating a session is refused explicitly. */
export const nodeInspector = Object.freeze({
  url: (): string | undefined => undefined,
  open: unsupported("open"),
  close: (): void => undefined,
  waitForDebugger: unsupported("waitForDebugger"),
  Session: class Session {
    constructor() { unsupported("Session")(); }
    connect(): never { return unsupported("Session.connect")(); }
    disconnect(): never { return unsupported("Session.disconnect")(); }
    post(): never { return unsupported("Session.post")(); }
  },
  console: Object.freeze({}),
});
