// Experimental Node-API observations (ADR 0026, 2.13) through experimental.c: each row is the
// status and what the call produced, or the exception's name. Resolves to the rows as JSON.
module.exports = async function exercise(addon) {
  const rows = [];
  const named = new Map([[null, "null"], [Object.prototype, "Object.prototype"]]);
  const describe = value => value === undefined ? "undefined" : value instanceof Error ? `error:${value.name}` : named.get(value) ?? (typeof value === "object" ? "object" : `${typeof value}:${String(value)}`);
  const setPrototype = (name, make) => {
    const events = [], { object, value, check } = make(events);
    const [status, detail] = addon.setPrototype(object, value);
    rows.push([name, status, describe(detail), check ? check() : "unchecked", events]);
  };
  setPrototype("set-prototype/ordinary", () => { const object = {}, value = { marker: 1 }; return { object, value, check: () => Object.getPrototypeOf(object) === value }; });
  setPrototype("set-prototype/null", () => { const object = {}; return { object, value: null, check: () => Object.getPrototypeOf(object) === null }; });
  setPrototype("set-prototype/non-extensible", () => { const object = Object.preventExtensions({}); return { object, value: {}, check: () => Object.getPrototypeOf(object) === Object.prototype }; });
  setPrototype("set-prototype/non-extensible-same", () => { const object = Object.preventExtensions({}); return { object, value: Object.prototype, check: () => Object.getPrototypeOf(object) === Object.prototype }; });
  setPrototype("set-prototype/cycle", () => { const first = {}, second = Object.create(first); return { object: first, value: second, check: () => Object.getPrototypeOf(first) === Object.prototype }; });
  setPrototype("set-prototype/immutable", () => ({ object: Object.prototype, value: {}, check: () => Object.getPrototypeOf(Object.prototype) === null }));
  setPrototype("set-prototype/number-value", () => { const object = {}; return { object, value: 42, check: () => Object.getPrototypeOf(object) === Object.prototype }; });
  setPrototype("set-prototype/undefined-value", () => { const object = {}; return { object, value: undefined, check: () => Object.getPrototypeOf(object) === Object.prototype }; });
  setPrototype("set-prototype/primitive-object", () => ({ object: 42, value: {} }));
  setPrototype("set-prototype/null-object", () => ({ object: null, value: {} }));
  setPrototype("set-prototype/proxy-trap", events => {
    const target = {}, value = {};
    const object = new Proxy(target, { setPrototypeOf(on, proto) { events.push("setPrototypeOf"); return Reflect.setPrototypeOf(on, proto); } });
    return { object, value, check: () => Object.getPrototypeOf(target) === value };
  });
  setPrototype("set-prototype/proxy-refuses", events => ({ object: new Proxy({}, { setPrototypeOf() { events.push("setPrototypeOf"); return false; } }), value: {} }));
  setPrototype("set-prototype/proxy-throws", events => ({ object: new Proxy({}, { setPrototypeOf() { events.push("setPrototypeOf"); throw new RangeError("refused"); } }), value: {} }));
  const createObject = (name, prototype, names, values) => {
    const [status, detail] = addon.createObject(prototype, names, values);
    if (status !== 0 || typeof detail !== "object" || detail === null) { rows.push([name, status, describe(detail)]); return; }
    const keys = Reflect.ownKeys(detail).map(key => typeof key === "symbol" ? `symbol:${key.description}` : key);
    const properties = Reflect.ownKeys(detail).map(key => { const d = Object.getOwnPropertyDescriptor(detail, key); return [d.value, d.writable, d.enumerable, d.configurable]; });
    rows.push([name, status, { prototype: describe(Object.getPrototypeOf(detail)), keys, properties, extensible: Object.isExtensible(detail) }]);
  };
  const marker = { marker: 1 }; named.set(marker, "marker");
  createObject("create/null-prototype", undefined, ["a", "b"], [1, 2]);
  createObject("create/prototype", marker, ["a"], [1]);
  createObject("create/explicit-null", null, ["a"], [1]);
  createObject("create/empty", marker, [], []);
  createObject("create/duplicate", undefined, ["a", "a"], [1, 2]);
  createObject("create/indices", undefined, ["1", "0", "x"], ["one", "zero", "x"]);
  createObject("create/symbol", undefined, [Symbol("s"), "t"], [1, 2]);
  createObject("create/not-a-name", undefined, ["a", 1], [1, 2]);
  createObject("create/object-name", undefined, [{}], [1]);
  const isShared = (name, value) => { const [status, detail] = addon.isShared(value); rows.push([name, status, describe(detail)]); };
  isShared("shared/shared", new SharedArrayBuffer(1));
  isShared("shared/array-buffer", new ArrayBuffer(1));
  isShared("shared/view", new Uint8Array(new SharedArrayBuffer(1)));
  isShared("shared/object", {});
  isShared("shared/tagged", { [Symbol.toStringTag]: "SharedArrayBuffer" });
  isShared("shared/null", null);
  isShared("shared/number", 42);
  const order = [];
  const [status] = addon.post(order);
  order.push("sync");
  queueMicrotask(() => order.push("microtask"));
  process.nextTick(() => order.push("nextTick"));
  setImmediate(() => order.push("immediate"));
  setTimeout(() => order.push("timeout"), 0);
  await new Promise(resolve => { setTimeout(resolve, 100); });
  rows.push(["post/order", status, order]);
  const [missing] = addon.postWithoutCallback();
  rows.push(["post/no-callback", missing]);
  return JSON.stringify(rows);
};
