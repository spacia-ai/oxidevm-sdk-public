import { describe, expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import type { KeeperMessage } from "../../runtime/preview-keeper.js";
import { frameKeeperHost } from "../host/keeper-host.js";
import { decodeFrameMessage } from "./requests.js";
import { decodeFrameReply } from "./replies.js";
import { isKeeperURL, keeperCommand, keeperReport } from "./keepers.js";

const SESSION = "0123456789abcdef0123456789abcdef";

function code(run: () => unknown): string {
  try { run(); } catch (error) { if (error instanceof VMError) return error.code; throw error; }
  throw new Error("expected a VMError");
}

describe("preview keeper relay", () => {
  it("lets the frame open only preview bootstraps below the page's own preview origin", () => {
    const origin = "https://oxvm.dev";
    expect(isKeeperURL(`https://${SESSION}.oxvm.dev/__oxidevm/?session=${SESSION}&parentOrigin=https%3A%2F%2Fapp.example`, origin, "per-session")).toBe(true);
    expect(isKeeperURL(`https://${SESSION}.oxvm.dev/elsewhere/`, origin, "per-session")).toBe(false);
    expect(isKeeperURL(`https://${SESSION}.evil.example/__oxidevm/`, origin, "per-session")).toBe(false);
    expect(isKeeperURL(`https://${SESSION}.oxvm.dev:8443/__oxidevm/`, origin, "per-session")).toBe(false);
    expect(isKeeperURL(`http://${SESSION}.oxvm.dev/__oxidevm/`, origin, "per-session")).toBe(false);
    expect(isKeeperURL("https://notasession.oxvm.dev/__oxidevm/", origin, "per-session")).toBe(false);
    expect(isKeeperURL("https://oxvm.dev/__oxidevm/", origin, "per-session")).toBe(false);
    expect(isKeeperURL("https://oxvm.dev/__oxidevm/", origin, "shared")).toBe(true);
    expect(isKeeperURL("not a url", origin, "shared")).toBe(false);
  });

  it("decodes keeper commands and reports with exact fields", () => {
    expect(decodeFrameReply(keeperCommand(1, { action: "open", url: "https://x/__oxidevm/" }))).toEqual({ type: "keeper", keeper: 1, action: "open", url: "https://x/__oxidevm/" });
    expect(decodeFrameReply(keeperCommand(2, { action: "retire", session: SESSION }))).toMatchObject({ action: "retire" });
    expect(code(() => decodeFrameReply(keeperCommand(2, { action: "retire", session: "short" })))).toBe("PROTOCOL_ERROR");
    expect(code(() => decodeFrameReply({ ...keeperCommand(1, { action: "close" }), extra: 1 }))).toBe("PROTOCOL_ERROR");
    expect(decodeFrameMessage(keeperReport(3, "https://x", { kind: "oxidevm-preview-ready", session: SESSION }))).toEqual({ type: "keeper.message", id: 3, origin: "https://x", data: { kind: "oxidevm-preview-ready", session: SESSION } });
  });

  it("opens keepers in the page, relays their messages to the session and posts back on their own origin", () => {
    const sent: { readonly message: Readonly<Record<string, unknown>>; readonly transfer: readonly Transferable[] }[] = [];
    const host = frameKeeperHost("https://app.example", (message, transfer) => sent.push({ message, transfer }));
    expect(host.origin).toBe("https://app.example");
    const keeper = host.open(new URL(`https://${SESSION}.oxvm.dev/__oxidevm/`));
    expect(sent[0]?.message).toMatchObject({ type: "keeper", keeper: 1, action: "open" });
    const heard: KeeperMessage[] = [];
    const stop = host.listen(message => heard.push(message));
    host.deliver(1, `https://${SESSION}.oxvm.dev`, { kind: "oxidevm-preview-connect", session: SESSION });
    host.deliver(9, "https://other", {});
    expect(heard).toHaveLength(1);
    expect(heard[0]?.source?.identity).toBe(keeper.source);
    const { port1, port2 } = new MessageChannel();
    heard[0]?.source?.postMessage({ kind: "oxidevm-preview-port", session: SESSION, port: port2 }, { targetOrigin: `https://${SESSION}.oxvm.dev`, transfer: [port2] });
    expect(sent[1]).toMatchObject({ message: { action: "post", targetOrigin: `https://${SESSION}.oxvm.dev` }, transfer: [port2] });
    keeper.retire(SESSION);
    keeper.close();
    expect(sent.map(entry => entry.message["action"])).toEqual(["open", "post", "retire", "close"]);
    host.deliver(1, `https://${SESSION}.oxvm.dev`, {});
    expect(heard).toHaveLength(1);
    stop();
    port1.close(); port2.close();
  });
});
