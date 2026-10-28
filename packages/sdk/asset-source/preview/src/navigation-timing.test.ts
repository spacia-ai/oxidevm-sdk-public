import { describe, expect, it } from "vitest";

import { reportServerDelivery } from "./navigation-timing";

/** The browser's timing classes as Chromium shapes them: accessors on the resource prototype,
 * which the navigation entry inherits. */
function timingClasses() {
  class Resource {
    readonly #transferSize: number;
    readonly #encodedBodySize: number;
    readonly #deliveryType: string;

    constructor(transferSize: number, encodedBodySize: number, deliveryType: string) {
      this.#transferSize = transferSize;
      this.#encodedBodySize = encodedBodySize;
      this.#deliveryType = deliveryType;
    }

    get transferSize(): number { return this.#transferSize; }
    get encodedBodySize(): number { return this.#encodedBodySize; }
    get deliveryType(): string { return this.#deliveryType; }
    toJSON(): Record<string, unknown> {
      return { transferSize: this.#transferSize, encodedBodySize: this.#encodedBodySize, deliveryType: this.#deliveryType };
    }
  }
  class Navigation extends Resource {}
  return { Resource, Navigation };
}

describe("navigation timing of a page the preview worker served", () => {
  it("reads as the server response it is, not as an HTTP-cache restore", () => {
    // Chromium reports a page a Service Worker built as transferSize 0 and deliveryType "cache";
    // Next.js 16.2 then reloads the page, and every reload is served the same way.
    const { Resource, Navigation } = timingClasses();
    reportServerDelivery({ resource: Resource, navigation: Navigation });
    const page = new Navigation(0, 58, "cache");
    expect(page.transferSize).toBe(358);
    expect(page.deliveryType).toBe("");
    expect(page.toJSON()).toEqual({ transferSize: 358, encodedBodySize: 58, deliveryType: "" });
  });

  it("keeps a page whose body is still streaming non-zero", () => {
    const { Resource, Navigation } = timingClasses();
    reportServerDelivery({ resource: Resource, navigation: Navigation });
    expect(new Navigation(0, 0, "cache").transferSize).toBe(300);
  });

  it("leaves network sizes, other delivery types and resource entries alone", () => {
    const { Resource, Navigation } = timingClasses();
    reportServerDelivery({ resource: Resource, navigation: Navigation });
    expect(new Navigation(361, 61, "").transferSize).toBe(361);
    expect(new Navigation(361, 61, "navigational-prefetch").deliveryType).toBe("navigational-prefetch");
    const script = new Resource(0, 10, "cache");
    expect(script.transferSize).toBe(0);
    expect(script.deliveryType).toBe("cache");
  });

  it("does nothing where the timing classes or their fields are missing", () => {
    expect(() => { reportServerDelivery({ resource: undefined, navigation: undefined }); }).not.toThrow();
    class Bare { readonly name = "bare"; }
    class BareNavigation extends Bare {}
    reportServerDelivery({ resource: Bare, navigation: BareNavigation });
    expect(Object.getOwnPropertyNames(BareNavigation.prototype)).toEqual(["constructor"]);
  });
});
