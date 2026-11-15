// napi_get_all_property_names observations (ADR 0026, 2.11): each row is the status, the keys
// (symbols by description) or the exception's name, and the Proxy traps V8 called, in order.
module.exports = function exercise(inspect) {
  const OWN = 1, PROTOTYPES = 0, NUMBERS = 0, STRINGS = 1;
  const W = 1, E = 2, C = 4, SKIP_STRINGS = 8, SKIP_SYMBOLS = 16;
  const rows = [];
  const describe = value => typeof value === "symbol" ? `symbol:${value.description}` : typeof value === "number" ? `number:${value}` : value;
  const observe = (name, make, mode, filter, conversion) => {
    const events = [], object = make(events);
    const [status, detail] = inspect(object, mode, filter, conversion);
    const value = Array.isArray(detail) ? detail.map(describe) : detail instanceof Error ? `error:${detail.name}` : detail === undefined ? "undefined" : `other:${typeof detail}`;
    rows.push([name, status, value, events]);
  };
  const symbol = Symbol("s"), inherited = Symbol("inherited");
  const ordinary = () => {
    const object = Object.create(null);
    object.b = 1; object[1] = "x"; object[0] = "y"; object[symbol] = 3;
    Object.defineProperties(object, {
      accessor: { get() { return 1; }, enumerable: true, configurable: true },
      setter: { set(value) { void value; }, enumerable: true, configurable: true },
      readOnly: { value: 1, writable: false, enumerable: true, configurable: true },
      hidden: { value: 1, writable: true, enumerable: false, configurable: true },
      fixed: { value: 1, writable: true, enumerable: true, configurable: false },
    });
    return object;
  };
  for (const [label, filter] of [["all", 0], ["writable", W], ["enumerable", E], ["configurable", C], ["skip-strings", SKIP_STRINGS], ["skip-symbols", SKIP_SYMBOLS], ["writable-enumerable-configurable", W | E | C], ["enumerable-skip-symbols", E | SKIP_SYMBOLS], ["skip-both", SKIP_STRINGS | SKIP_SYMBOLS], ["unknown-bits", 1 << 8]]) {
    observe(`ordinary/${label}/strings`, ordinary, OWN, filter, STRINGS);
  }
  observe("ordinary/all/numbers", ordinary, OWN, 0, NUMBERS);
  const chain = () => {
    const base = Object.create(null); base.p = 1; base.shadow = 2; base[inherited] = 3; base[5] = "five";
    const child = Object.create(base); child.c = 1; child[2] = "two";
    Object.defineProperty(child, "shadow", { value: 1, enumerable: false, configurable: true, writable: true });
    return child;
  };
  for (const [label, filter] of [["all", 0], ["enumerable", E], ["writable", W], ["skip-symbols", SKIP_SYMBOLS]]) observe(`prototypes/${label}`, chain, PROTOTYPES, filter, STRINGS);
  observe("prototypes/all/numbers", chain, PROTOTYPES, 0, NUMBERS);
  const holey = () => { const array = [1, 2, 3]; delete array[1]; return array; };
  observe("array/all", () => { const array = holey(); array.x = 1; return array; }, OWN, 0, STRINGS);
  observe("array/writable-enumerable", holey, OWN, W | E, NUMBERS);
  observe("typed-array/all", () => new Uint8Array(3), OWN, 0, NUMBERS);
  observe("typed-array/configurable", () => new Uint8Array(2), OWN, C, STRINGS);
  observe("string-object/all", () => new String("ab"), OWN, 0, STRINGS);
  observe("string-object/writable", () => new String("ab"), OWN, W, STRINGS);
  observe("string-object/enumerable", () => new String("ab"), OWN, E, STRINGS);
  observe("string-object/configurable", () => new String("ab"), OWN, C, STRINGS);
  observe("string-object/extra", () => { const string = new String("ab"); string.x = 1; string[5] = "five"; return string; }, OWN, 0, NUMBERS);
  observe("frozen/writable", () => Object.freeze({ a: 1, b: 2 }), OWN, W, STRINGS);
  observe("frozen-array/writable", () => Object.freeze([1, 2]), OWN, W, STRINGS);
  observe("array/read-only-element", () => { const array = [1, 2]; Object.defineProperty(array, 0, { writable: false }); return array; }, OWN, W, NUMBERS);
  observe("frozen-object-indices/writable", () => Object.freeze({ 0: "a", 1: "b", x: 1 }), OWN, W, STRINGS);
  observe("sealed-array/configurable", () => Object.seal([1, 2]), OWN, C, STRINGS);
  observe("sealed-array/writable", () => Object.seal([1, 2]), OWN, W, STRINGS);
  observe("non-extensible-array/configurable", () => Object.preventExtensions([1, 2]), OWN, C, STRINGS);
  observe("frozen-dictionary-array/writable", () => { const array = [1, 2]; Object.defineProperty(array, 1, { writable: false }); return Object.freeze(array); }, OWN, W, STRINGS);
  observe("frozen-sparse-array/writable", () => { const array = []; array[100000] = 1; return Object.freeze(array); }, OWN, W, STRINGS);
  observe("frozen-holey-array/writable", () => Object.freeze(holey()), OWN, W, STRINGS);
  observe("arguments/all", () => (function () { return arguments; })(1, 2), OWN, 0, STRINGS);
  observe("arguments/frozen-writable", () => Object.freeze((function () { return arguments; })(1, 2)), OWN, W, STRINGS);
  observe("private-fields", () => new (class { #hidden = 1; shown = 2; hidden() { return this.#hidden; } })(), OWN, 0, STRINGS);
  observe("indices/order", () => ({ "4294967295": 1, "4294967294": 2, "-1": 3, "01": 4, "10": 5, "2": 6, z: 7 }), OWN, 0, NUMBERS);
  observe("primitive/number", () => 42, OWN, 0, STRINGS);
  observe("primitive/string", () => "ab", OWN, 0, NUMBERS);
  observe("null", () => null, OWN, 0, STRINGS);
  observe("undefined", () => undefined, OWN, 0, STRINGS);
  const traced = (events, target, traps = ["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"]) => {
    const handler = {};
    if (traps.includes("ownKeys")) handler.ownKeys = object => { events.push("ownKeys"); return Reflect.ownKeys(object); };
    if (traps.includes("getOwnPropertyDescriptor")) handler.getOwnPropertyDescriptor = (object, key) => { events.push(`descriptor:${describe(key)}`); return Reflect.getOwnPropertyDescriptor(object, key); };
    if (traps.includes("getPrototypeOf")) handler.getPrototypeOf = object => { events.push("getPrototypeOf"); return Reflect.getPrototypeOf(object); };
    return new Proxy(target, handler);
  };
  const proxyTarget = () => {
    const target = Object.create(null);
    Object.defineProperties(target, { locked: { value: 1, enumerable: true }, open: { value: 2, writable: true, enumerable: true, configurable: true }, quiet: { value: 3, writable: true, configurable: true } });
    target[7] = "seven"; target[symbol] = 1;
    return target;
  };
  for (const [label, filter] of [["all", 0], ["writable-configurable", W | C], ["enumerable", E], ["skip-strings", SKIP_STRINGS], ["skip-symbols-enumerable", SKIP_SYMBOLS | E]]) {
    observe(`proxy/${label}`, events => traced(events, proxyTarget()), OWN, filter, STRINGS);
  }
  observe("proxy/numbers", events => traced(events, proxyTarget()), OWN, 0, NUMBERS);
  observe("proxy/no-traps/enumerable", events => traced(events, proxyTarget(), []), OWN, E, NUMBERS);
  observe("proxy/descriptor-only/enumerable", events => traced(events, proxyTarget(), ["getOwnPropertyDescriptor"]), OWN, E, STRINGS);
  observe("proxy/revoked", () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }, OWN, 0, STRINGS);
  observe("proxy/own-keys-throws", () => new Proxy({}, { ownKeys() { throw new RangeError("own keys"); } }), OWN, 0, STRINGS);
  observe("proxy/own-keys-duplicate", () => new Proxy({}, { ownKeys() { return ["a", "a"]; } }), OWN, 0, STRINGS);
  observe("proxy/own-keys-invalid", () => new Proxy({}, { ownKeys() { return [1]; } }), OWN, 0, STRINGS);
  observe("proxy/descriptor-throws", () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new SyntaxError("descriptor"); } }), OWN, E, STRINGS);
  observe("proxy/descriptor-throws-unfiltered", () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new SyntaxError("descriptor"); } }), OWN, W, STRINGS);
  observe("proxy/prototypes/receiver", events => traced(events, chain()), PROTOTYPES, 0, STRINGS);
  observe("proxy/prototypes/receiver-enumerable", events => traced(events, chain()), PROTOTYPES, E, STRINGS);
  observe("proxy/prototypes/in-chain", events => { const object = Object.create(traced(events, chain())); object.own = 1; return object; }, PROTOTYPES, 0, STRINGS);
  observe("proxy/prototypes/in-chain-enumerable", events => { const object = Object.create(traced(events, chain())); object.own = 1; return object; }, PROTOTYPES, E, STRINGS);
  const named = new Map([[null, "null"], [Object.prototype, "Object.prototype"], [Number.prototype, "Number.prototype"]]);
  const prototypeRow = (name, make) => {
    const events = [], marker = { marker: true }, object = make(events, marker);
    const [status, detail] = inspect.prototypeOf(object);
    rows.push([name, status, detail === marker ? "marker" : named.get(detail) ?? (detail instanceof Error ? `error:${detail.name}` : `other:${typeof detail}`), events]);
  };
  prototypeRow("prototype/ordinary", (_events, marker) => Object.create(marker));
  prototypeRow("prototype/primitive", () => 42);
  prototypeRow("prototype/proxy-trap", (events, marker) => new Proxy(Object.create(marker), { getPrototypeOf(target) { events.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); } }));
  prototypeRow("prototype/proxy-no-trap", (_events, marker) => new Proxy(Object.create(marker), {}));
  prototypeRow("prototype/revoked", () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; });
  prototypeRow("prototype/null", () => null);
  observe("invalid/mode", ordinary, 2, 0, STRINGS);
  observe("invalid/conversion", ordinary, OWN, 0, 2);
  return JSON.stringify(rows);
};
