// A page the preview's Service Worker serves comes fresh from the guest's server on every
// navigation, but the browser reports any response a worker builds as a cache delivery
// (`transferSize` 0, `deliveryType` "cache"). Frameworks read those fields to tell an HTTP-cache
// restore from a server response: Next.js 16.2's development client reloads a page it takes for
// a cache restore it cannot complete, and since every preview page is served this way, it
// reloaded without end. The document's own entry therefore reads as the server response it is:
// its body size plus the 300 bytes Resource Timing counts for headers, and no delivery type.

/** Header bytes Resource Timing adds to a body fetched over the network. */
const HEADER_BYTES = 300;

export interface TimingClasses {
  /** `PerformanceResourceTiming`, which defines the fields. */
  readonly resource: unknown;
  /** `PerformanceNavigationTiming`, the class of the document's own entry. */
  readonly navigation: unknown;
}

export function reportServerDelivery(classes: TimingClasses): void {
  const resource = prototypeOf(classes.resource);
  const navigation = prototypeOf(classes.navigation);
  if (resource === undefined || navigation === undefined) return;
  const transferSize = getter(resource, "transferSize");
  const encodedBodySize = getter(resource, "encodedBodySize");
  if (transferSize === undefined || encodedBodySize === undefined) return;
  const deliveryType = getter(resource, "deliveryType");
  const serverTransferSize = (entry: unknown): unknown => {
    const size: unknown = Reflect.apply(transferSize, entry, []);
    const body: unknown = Reflect.apply(encodedBodySize, entry, []);
    return size === 0 && typeof body === "number" ? body + HEADER_BYTES : size;
  };
  const serverDeliveryType = (entry: unknown): unknown => {
    const type: unknown = deliveryType === undefined ? undefined : Reflect.apply(deliveryType, entry, []);
    return type === "cache" ? "" : type;
  };
  Object.defineProperty(navigation, "transferSize", { configurable: true, enumerable: true, get(this: unknown) { return serverTransferSize(this); } });
  if (deliveryType !== undefined) {
    Object.defineProperty(navigation, "deliveryType", { configurable: true, enumerable: true, get(this: unknown) { return serverDeliveryType(this); } });
  }
  const toJSON: unknown = Reflect.get(navigation, "toJSON");
  if (!isMethod(toJSON)) return;
  // The serialized entry agrees with the fields.
  Object.defineProperty(navigation, "toJSON", {
    configurable: true,
    writable: true,
    value(this: unknown): unknown {
      const json: unknown = Reflect.apply(toJSON, this, []);
      if (typeof json !== "object" || json === null) return json;
      return {
        ...json,
        transferSize: serverTransferSize(this),
        ...(deliveryType === undefined ? {} : { deliveryType: serverDeliveryType(this) }),
      };
    },
  });
}

function prototypeOf(value: unknown): object | undefined {
  if (typeof value !== "function") return undefined;
  const prototype: unknown = Reflect.get(value, "prototype");
  return typeof prototype === "object" && prototype !== null ? prototype : undefined;
}

function getter(prototype: object, name: string): ((this: unknown) => unknown) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  const accessor: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, "get");
  return isMethod(accessor) ? accessor : undefined;
}

function isMethod(value: unknown): value is (this: unknown) => unknown {
  return typeof value === "function";
}
