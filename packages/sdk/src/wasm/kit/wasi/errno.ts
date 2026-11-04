/** WASI Preview1 errno values (wasi_snapshot_preview1.witx `errno`). */
export const WASI = {
  success: 0, toobig: 1, acces: 2, addrinuse: 3, addrnotavail: 4, afnosupport: 5, again: 6, already: 7, badf: 8, badmsg: 9,
  busy: 10, canceled: 11, child: 12, connaborted: 13, connrefused: 14, connreset: 15, deadlk: 16, destaddrreq: 17, dom: 18,
  dquot: 19, exist: 20, fault: 21, fbig: 22, hostunreach: 23, idrm: 24, ilseq: 25, inprogress: 26, intr: 27, inval: 28,
  io: 29, isconn: 30, isdir: 31, loop: 32, mfile: 33, mlink: 34, msgsize: 35, multihop: 36, nametoolong: 37, netdown: 38,
  netreset: 39, netunreach: 40, nfile: 41, nobufs: 42, nodev: 43, noent: 44, noexec: 45, nolck: 46, nolink: 47, nomem: 48,
  nomsg: 49, noprotoopt: 50, nospc: 51, nosys: 52, notconn: 53, notdir: 54, notempty: 55, notrecoverable: 56, notsock: 57,
  notsup: 58, notty: 59, nxio: 60, overflow: 61, ownerdead: 62, perm: 63, pipe: 64, proto: 65, protonosupport: 66,
  prototype: 67, range: 68, rofs: 69, spipe: 70, srch: 71, stale: 72, timedout: 73, txtbsy: 74, xdev: 75, notcapable: 76,
} as const;
export type WasiErrno = (typeof WASI)[keyof typeof WASI];

/** Linux (x86-64) errno → WASI errno. A Linux error with no WASI name becomes `io`, never success. */
const FROM_LINUX: ReadonlyMap<number, WasiErrno> = new Map<number, WasiErrno>([
  [1, WASI.perm], [2, WASI.noent], [3, WASI.srch], [4, WASI.intr], [5, WASI.io], [6, WASI.nxio], [7, WASI.toobig],
  [8, WASI.noexec], [9, WASI.badf], [10, WASI.child], [11, WASI.again], [12, WASI.nomem], [13, WASI.acces], [14, WASI.fault],
  [16, WASI.busy], [17, WASI.exist], [18, WASI.xdev], [19, WASI.nodev], [20, WASI.notdir], [21, WASI.isdir], [22, WASI.inval],
  [23, WASI.nfile], [24, WASI.mfile], [25, WASI.notty], [26, WASI.txtbsy], [27, WASI.fbig], [28, WASI.nospc], [29, WASI.spipe],
  [30, WASI.rofs], [31, WASI.mlink], [32, WASI.pipe], [33, WASI.dom], [34, WASI.range], [35, WASI.deadlk], [36, WASI.nametoolong],
  [37, WASI.nolck], [38, WASI.nosys], [39, WASI.notempty], [40, WASI.loop], [42, WASI.nomsg], [43, WASI.idrm], [67, WASI.nolink],
  [71, WASI.proto], [72, WASI.multihop], [74, WASI.badmsg], [75, WASI.overflow], [84, WASI.ilseq], [88, WASI.notsock],
  [89, WASI.destaddrreq], [90, WASI.msgsize], [91, WASI.prototype], [92, WASI.noprotoopt], [93, WASI.protonosupport],
  [95, WASI.notsup], [97, WASI.afnosupport], [98, WASI.addrinuse], [99, WASI.addrnotavail], [100, WASI.netdown],
  [101, WASI.netunreach], [102, WASI.netreset], [103, WASI.connaborted], [104, WASI.connreset], [105, WASI.nobufs],
  [106, WASI.isconn], [107, WASI.notconn], [110, WASI.timedout], [111, WASI.connrefused], [113, WASI.hostunreach],
  [114, WASI.already], [115, WASI.inprogress], [116, WASI.stale], [122, WASI.dquot], [125, WASI.canceled],
  [130, WASI.ownerdead], [131, WASI.notrecoverable],
]);

export function wasiErrno(linuxErrno: number): WasiErrno {
  return FROM_LINUX.get(linuxErrno) ?? WASI.io;
}
