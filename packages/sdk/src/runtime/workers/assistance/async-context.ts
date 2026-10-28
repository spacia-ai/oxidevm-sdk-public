import { createAsyncResources } from "./async-resources.js";

type Restore = () => void;
type Install = () => Restore;
const restores: Restore[] = [], apply = Reflect.apply, restorePush = Reflect.get(restores, "push"), restoreReverse = Reflect.get(restores, "reverse");
interface Slot {
  capture(): Install;
  clear(): Restore;
}
const Map = globalThis.Map, Set = globalThis.Set;
const slotSet = new Set<Slot>(), slotMap = new Map<Slot, Install>();
const slotAdd = Reflect.get(slotSet, "add"), slotDelete = Reflect.get(slotSet, "delete"), slotHas = Reflect.get(slotSet, "has"), slotValues = Reflect.get(slotSet, "values");
const slotNext = Reflect.get(apply(slotValues, slotSet, []), "next");
const snapshotSet = Reflect.get(slotMap, "set"), snapshotGet = Reflect.get(slotMap, "get"), snapshotKeys = Reflect.get(slotMap, "keys");
const snapshotNext = Reflect.get(apply(snapshotKeys, slotMap, []), "next");

function visitSlots(slots: ReadonlySet<Slot>, visit: (slot: Slot) => void): void {
  const iterator = apply(slotValues, slots, []);
  for (let step = apply(slotNext, iterator, []); step.done !== true; step = apply(slotNext, iterator, [])) visit(step.value);
}
function unionSlots(left: ReadonlySet<Slot>, right: ReadonlySet<Slot>): Set<Slot> {
  const result = new Set<Slot>();
  visitSlots(left, slot => { apply(slotAdd, result, [slot]); });
  visitSlots(right, slot => { apply(slotAdd, result, [slot]); });
  return result;
}
function restoreSlots(restores: Restore[]): void {
  const reversed = apply(restoreReverse, restores, []);
  for (let index = 0; index < reversed.length; index++) {
    const restore = reversed[index]; if (restore === undefined) throw new Error("Missing async storage restoration");
    restore();
  }
}

interface ContextStorage<Value> {
  getStore(): Value | undefined;
  run<Args extends unknown[], Result>(value: Value, callback: (...args: Args) => Result, ...args: Args): Result;
  enterWith(value: Value): void;
  exit<Args extends unknown[], Result>(callback: (...args: Args) => Result, ...args: Args): Result;
  disable(): void;
}

/** Explicit public shape keeps private storage fields out of emitted declarations. */
export interface AsyncContext {
  readonly resources: ReturnType<typeof createAsyncResources>;
  readonly AsyncLocalStorage: {
    new <Value>(): ContextStorage<Value>;
    bind<Receiver, Args extends unknown[], Result>(callback: (this: Receiver, ...args: Args) => Result): (this: Receiver, ...args: Args) => Result;
    snapshot(): <Args extends unknown[], Result>(callback: (...args: Args) => Result, ...args: Args) => Result;
  };
  capture(): <Result>(callback: () => Result) => Result;
  clear(): Restore;
}

/** Process-local context storage. Scheduling adapters must explicitly capture it.
 * This alone is not native-await support: all admitted code must be lowered.
 */
export function createAsyncContext(): AsyncContext {
  const resources = createAsyncResources();
  const slots = new Set<Slot>();
  let capturedSlots = new Set<Slot>();

  function clear(): Restore {
    const previous = unionSlots(slots, capturedSlots), restore: Restore[] = [];
    visitSlots(previous, slot => { apply(restorePush, restore, [slot.clear()]); });
    return () => {
      visitSlots(unionSlots(slots, capturedSlots), slot => { if (!apply(slotHas, previous, [slot])) slot.clear(); });
      restoreSlots(restore);
    };
  }

  function capture() {
    const snapshot = new Map<Slot, Install>();
    visitSlots(unionSlots(slots, capturedSlots), slot => { apply(snapshotSet, snapshot, [slot, slot.capture()]); });
    return function runCaptured<Result>(callback: () => Result): Result {
      const restore: Restore[] = [];
      const previousSlots = capturedSlots;
      capturedSlots = unionSlots(slots, previousSlots);
      const iterator = apply(snapshotKeys, snapshot, []);
      for (let step = apply(snapshotNext, iterator, []); step.done !== true; step = apply(snapshotNext, iterator, [])) apply(slotAdd, capturedSlots, [step.value]);
      visitSlots(capturedSlots, slot => { apply(restorePush, restore, [(apply(snapshotGet, snapshot, [slot]) ?? (() => slot.clear()))()]); });
      try {
        return callback();
      } finally {
        restoreSlots(restore);
        capturedSlots = previousSlots;
      }
    };
  }

  class AsyncLocalStorage<Value> {
    #value: Value | undefined;
    readonly #slot: Slot = {
      capture: () => {
        const value = this.#value;
        return () => this.#install(value);
      },
      clear: () => this.#install(undefined),
    };

    #install(value: Value | undefined): Restore {
      const previous = this.#value;
      const registered = apply(slotHas, slots, [this.#slot]);
      this.#value = value;
      return () => {
        this.#value = previous;
        if (registered) apply(slotAdd, slots, [this.#slot]);
        else apply(slotDelete, slots, [this.#slot]);
      };
    }

    getStore(): Value | undefined {
      return this.#value;
    }

    run<Args extends unknown[], Result>(
      value: Value, callback: (...args: Args) => Result, ...args: Args
    ): Result {
      apply(slotAdd, slots, [this.#slot]);
      const restore = this.#install(value);
      try {
        return callback(...args);
      } finally {
        restore();
      }
    }

    enterWith(value: Value): void {
      apply(slotAdd, slots, [this.#slot]);
      this.#value = value;
    }

    exit<Args extends unknown[], Result>(callback: (...args: Args) => Result, ...args: Args): Result {
      const restore = this.#install(undefined);
      try {
        return callback(...args);
      } finally {
        restore();
      }
    }

    disable(): void {
      this.#value = undefined;
      apply(slotDelete, slots, [this.#slot]);
    }

    static bind<Receiver, Args extends unknown[], Result>(
      callback: (this: Receiver, ...args: Args) => Result,
    ): (this: Receiver, ...args: Args) => Result {
      const run = capture();
      const bound = function (this: Receiver, ...args: Args): Result {
        return run(() => scope.run(() => apply(callback, this, args)));
      };
      const scope = resources.create("bound-anonymous-fn", bound);
      return bound;
    }

    static snapshot() {
      const run = capture();
      const bound = function <Args extends unknown[], Result>(
        callback: (...args: Args) => Result, ...args: Args
      ): Result {
        return run(() => scope.run(() => callback(...args)));
      };
      const scope = resources.create("bound-anonymous-fn", bound);
      return bound;
    }
  }

  return { AsyncLocalStorage, capture, clear, resources };
}
