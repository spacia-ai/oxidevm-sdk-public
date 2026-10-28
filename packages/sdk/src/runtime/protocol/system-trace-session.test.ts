import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { decodeSystemTraceSession } from "./system-trace-session.js";

const session = { active: true, paused: false, stopping: false, awaitingConsoleAck: true, waiting: "yield-task" } as const;

describe("system trace session state", () => {
  it("decodes the v35 session pump state exactly", () => {
    expect(decodeSystemTraceSession(session, 35)).toEqual(session);
    expect(decodeSystemTraceSession({ ...session, active: false, waiting: "none" }, 35)).toMatchObject({ active: false, waiting: "none" });
  });

  it("rejects unknown waits, extra fields and pre-v35 evidence", () => {
    expect(() => decodeSystemTraceSession({ ...session, waiting: "sleeping" }, 35)).toThrow(VMError);
    expect(() => decodeSystemTraceSession({ ...session, extra: 1 }, 35)).toThrow(VMError);
    expect(() => decodeSystemTraceSession(session, 34)).toThrow(VMError);
  });
});
