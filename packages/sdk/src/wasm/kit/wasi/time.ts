import type { FileDescriptor } from "../../../js-process-types.js";
import { WASI, type WasiErrno } from "./errno.js";
import type { ClockHost } from "../../../js-process-types.js";
import { WasiError, type WasiContext } from "./context.js";
import { RIGHT } from "./rights.js";

type ImportFunction = (...args: never[]) => number;
const CLOCKS = ["realtime", "monotonic"] as const;
const SUBSCRIPTION = 48, EVENT = 32, MAX_SUBSCRIPTIONS = 16;
const TAG = { clock: 0, read: 1, write: 2 } as const;
const POLLIN = 1, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;
const NS_PER_MS = 1_000_000n, MAX_WAIT_MS = 86_400_000n;

function clockOf(id: number): (typeof CLOCKS)[number] {
  const clock = CLOCKS[id];
  // Process and thread CPU-time clocks have no VM owner: refused, never imitated with wall time.
  if (clock === undefined) throw new WasiError(WASI.inval);
  return clock;
}
function requireClock(context: WasiContext): ClockHost {
  const clock = context.host.clock;
  if (clock === undefined) throw new WasiError(WASI.nosys);
  return clock;
}

type Subscription =
  | { readonly kind: "clock"; readonly userdata: bigint; readonly deadline: bigint; readonly clock: (typeof CLOCKS)[number] }
  | { readonly kind: "fd"; readonly userdata: bigint; readonly tag: 1 | 2; readonly fd: FileDescriptor | undefined; readonly error: WasiErrno };

/**
 * clock_*, poll_oneoff and random_get. poll_oneoff turns every subscription into one engine-owned wait: descriptor
 * readiness and the nearest clock deadline together (`files.at` poll with a timeout). A sleep with no descriptors waits
 * on a private pipe that never becomes ready. Nothing spins, and a signal that ends the process ends the wait.
 */
export function timeFunctions(context: WasiContext): Readonly<Record<string, ImportFunction>> {
  const memory = () => context.memory();
  let idle: FileDescriptor | undefined;
  /** The read end of a private pipe whose writer stays open: it never becomes ready, so a wait on it is a pure sleep. */
  const idleDescriptor = (): FileDescriptor => {
    if (idle === undefined) {
      const [read, write] = context.host.fs.pipe();
      context.table.adopt(read); context.table.adopt(write);
      idle = read;
    }
    return idle;
  };
  const decode = (pointer: number, count: number): readonly Subscription[] => {
    const guest = memory();
    guest.check(pointer, count * SUBSCRIPTION);
    return Array.from({ length: count }, (_, index): Subscription => {
      const at = pointer + index * SUBSCRIPTION, userdata = guest.u64(at), tag = guest.read(at + 8, 1)[0];
      if (tag === TAG.clock) {
        const clock = clockOf(guest.u32(at + 16)), timeout = guest.u64(at + 24), flags = guest.read(at + 40, 2);
        const absolute = ((flags[0] ?? 0) & 1) !== 0;
        return { kind: "clock", userdata, clock, deadline: absolute ? timeout : requireClock(context).now(clock) + timeout };
      }
      if (tag !== TAG.read && tag !== TAG.write) throw new WasiError(WASI.inval);
      try {
        const entry = context.table.require(guest.u32(at + 16), tag === TAG.read ? RIGHT.fdRead : RIGHT.fdWrite);
        return { kind: "fd", userdata, tag, fd: entry.host, error: WASI.success };
      } catch (error) {
        return { kind: "fd", userdata, tag, fd: undefined, error: context.errnoOf(error) };
      }
    });
  };
  return {
    clock_res_get: (id: number, out: number) => context.guarded(() => {
      const clock = clockOf(id), value = requireClock(context).resolution(clock);
      memory().check(out, 8); memory().setU64(out, value);
    }),
    clock_time_get: (id: number, _precision: bigint, out: number) => context.guarded(() => {
      const clock = clockOf(id), value = requireClock(context).now(clock);
      memory().check(out, 8); memory().setU64(out, value);
    }),
    poll_oneoff: (input: number, output: number, count: number, outCount: number) => context.guarded(() => {
      if (count < 1 || count > MAX_SUBSCRIPTIONS) throw new WasiError(WASI.inval);
      const guest = memory();
      guest.check(output, count * EVENT); guest.check(outCount, 4);
      const subscriptions = decode(input, count);
      const events: { userdata: bigint; error: WasiErrno; type: number; hangup: boolean }[] = [];
      // A subscription to a descriptor the program cannot poll reports its own error at once.
      for (const subscription of subscriptions) if (subscription.kind === "fd" && subscription.error !== WASI.success) events.push({ userdata: subscription.userdata, error: subscription.error, type: subscription.tag, hangup: false });
      const descriptors: { readonly fd: FileDescriptor; readonly events: 1 | 4; readonly userdata: bigint; readonly tag: 1 | 2 }[] = subscriptions.flatMap(subscription =>
        subscription.kind === "fd" && subscription.fd !== undefined ? [{ fd: subscription.fd, events: subscription.tag === TAG.read ? POLLIN : POLLOUT, userdata: subscription.userdata, tag: subscription.tag }] : []);
      const clocks = subscriptions.flatMap(subscription => subscription.kind === "clock" ? [subscription] : []);
      if (events.length === 0) {
        let timeout = -1n;
        if (clocks.length > 0) {
          const host = requireClock(context);
          const remaining = clocks.map(clock => clock.deadline - host.now(clock.clock)).reduce((low, value) => value < low ? value : low);
          timeout = remaining <= 0n ? 0n : (remaining + NS_PER_MS - 1n) / NS_PER_MS;
          if (timeout > MAX_WAIT_MS) timeout = MAX_WAIT_MS;
        }
        if (descriptors.length > 16) throw new WasiError(WASI.inval);
        const entries: readonly { readonly fd: FileDescriptor; readonly events: 1 | 4 }[] = descriptors.length === 0 ? [{ fd: idleDescriptor(), events: POLLIN }] : descriptors.map(entry => ({ fd: entry.fd, events: entry.events }));
        const ready = context.at.poll(entries, Number(timeout));
        let readyCount = 0;
        for (const descriptor of descriptors) {
          const result = ready.find(entry => entry.fd === descriptor.fd);
          if (result === undefined || result.revents === 0) continue;
          const error = (result.revents & POLLNVAL) !== 0 ? WASI.badf : (result.revents & POLLERR) !== 0 && (result.revents & (POLLIN | POLLOUT)) === 0 ? WASI.io : WASI.success;
          events.push({ userdata: descriptor.userdata, error, type: descriptor.tag, hangup: (result.revents & POLLHUP) !== 0 });
          readyCount += 1;
        }
        if (readyCount === 0 && clocks.length > 0) {
          const host = requireClock(context);
          for (const clock of clocks) if (host.now(clock.clock) >= clock.deadline) events.push({ userdata: clock.userdata, error: WASI.success, type: TAG.clock, hangup: false });
        }
      }
      events.forEach((event, index) => {
        const at = output + index * EVENT;
        guest.write(at, new Uint8Array(EVENT));
        guest.setU64(at, event.userdata);
        guest.write(at + 8, Uint8Array.of(event.error & 0xff, event.error >> 8, event.type));
        if (event.hangup) guest.write(at + 24, Uint8Array.of(1));
      });
      guest.setU32(outCount, events.length);
    }),
    random_get: (buffer: number, length: number) => context.guarded(() => {
      const random = context.host.random;
      if (random === undefined) throw new WasiError(WASI.nosys);
      memory().check(buffer, length);
      for (let offset = 0; offset < length; offset += 65536) {
        const chunk = new Uint8Array(Math.min(65536, length - offset));
        random.fill(chunk);
        memory().write(buffer + offset, chunk);
      }
    }),
  };
}
