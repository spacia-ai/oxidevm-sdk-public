import { describe, expect, it } from "vitest";

import { HtmlInjector, pageScripts, WEBSOCKET_SCRIPT } from "./html-injector";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (...parts: readonly Uint8Array[]): string => parts.map((part) => new TextDecoder().decode(part)).join("");

describe("page scripts", () => {
  it("puts the WebSocket shim and the location script right after <head>, across chunks", () => {
    const injector = new HtmlInjector(pageScripts("https://p.example"));
    const out = text(injector.push(bytes("<!doctype html><html><he")), injector.push(bytes("ad><title>x</title>")), injector.finish());
    expect(out).toBe('<!doctype html><html><head><script src="/__oxidevm/websocket.js"></script>'
      + '<script src="/__oxidevm/location.js" data-oxidevm-parent="https://p.example"></script><title>x</title>');
  });

  it("injects only the WebSocket shim while no parent is known", () => {
    expect(text(pageScripts(null))).toBe(`<script src="${WEBSOCKET_SCRIPT}"></script>`);
  });

  it.each([['https://p.example/"><x'], ["http://10.0.0.2:5173"], ["https://p.example/"]])("refuses page scripts for the parent %s", (parent) => {
    expect(() => pageScripts(parent)).toThrow("page scripts need a bare parent origin");
  });

  it("puts the scripts after the doctype when the page has no <head>", () => {
    const injector = new HtmlInjector(bytes("<s>"));
    expect(text(injector.push(bytes("<!doctype html><p>hi</p>")), injector.finish())).toBe("<!doctype html><s><p>hi</p>");
  });
});
