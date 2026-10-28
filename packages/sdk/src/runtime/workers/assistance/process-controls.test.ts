import { expect, it, vi } from "vitest";
import { restrictProcessControls } from "./process-controls.js";

it("keeps global and prototype worker controls private after capturing the owner transport", () => {
  const postMessage = vi.fn(), close = vi.fn(), prototype = { postMessage, close };
  const scope = {}; Object.setPrototypeOf(scope, prototype);
  const ownerPost = postMessage.bind(scope);
  restrictProcessControls(scope);
  ownerPost("owner"); expect(postMessage).toHaveBeenCalledWith("owner");
  for (const object of [scope, prototype]) for (const key of ["postMessage", "close"]) {
    const value: unknown = Reflect.get(object, key);
    expect(typeof value).toBe("function");
    if (typeof value === "function") expect((): unknown => Reflect.apply(value, scope, [])).toThrow(/private to the process owner/u);
    expect(Reflect.set(object, key, vi.fn())).toBe(false);
  }
  expect(close).not.toHaveBeenCalled();
});
