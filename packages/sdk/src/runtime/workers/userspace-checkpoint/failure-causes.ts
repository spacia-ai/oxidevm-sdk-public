// ABI75 introduced these closed tags; ABI116 adds Netlink allocation accounting.
// Two u32 words contain at most eight little-endian u8 tags. The final u32 is a leaf scalar.
import { VMError } from "../../errors.js";
type Scalar = "errno" | "version" | "cpu-field" | "control-register";
type Variant = string | { readonly kind: "child"; readonly name: string; readonly node: string }
  | { readonly kind: "scalar"; readonly name: string; readonly scalar: Scalar };
const NODES: Readonly<Record<string, readonly Variant[]>> = {
  "memory": [
    "bounds",
    "invalid-reference",
    "invalid-state",
    "accounting",
    "poisoned"
  ],
  "vfs": [
    "bounds",
    "invalid-reference",
    "invalid-state",
    "accounting",
    "poisoned",
    "legacy-posix-lock-owner-missing"
  ],
  "namespace": [
    "bounds",
    "invalid-reference",
    "invalid-identity",
    "invalid-state",
    "invalid-hierarchy",
    "missing-lease",
    "poisoned"
  ],
  "cgroup": [
    "bounds",
    "invalid-reference",
    "invalid-hierarchy",
    "accounting",
    "missing-lease",
    "invalid-program"
  ],
  "signals": [
    "bounds",
    "invalid-id",
    "invalid-action",
    "invalid-pending",
    "invalid-task",
    "invalid-frame",
    "invalid-cpu",
    "accounting",
    "unowned-budget",
    "root-already-taken",
    "unused-root"
  ],
  "seccomp": [
    "authority",
    "accounting",
    "identity",
    "parent",
    "bytecode",
    "flags",
    "unreachable",
    "released-count",
    "decision"
  ],
  "pipe": [
    "bounds",
    "invalid-state",
    "invalid-reference",
    "accounting"
  ],
  "pty": [
    "bounds",
    "invalid-state",
    "invalid-reference",
    "accounting"
  ],
  "event": [
    "bounds",
    "invalid-state",
    "invalid-reference",
    { "kind": "child", "name": "io-uring-workers", "node": "io-uring-workers" }
  ],
  "io-uring-workers": [
    "invalid-state", "invalid-reference", "poisoned",
    { "kind": "child", "name": "cgroup", "node": "cgroup" }
  ],
  "unix": [
    "bounds",
    "reference",
    "state",
    "accounting",
    "busy",
    "poisoned"
  ],
  "inet": [
    "identity",
    "namespace",
    "address",
    "reference",
    "state",
    "buffer"
  ],
  "netlink": [
    "identity",
    "namespace",
    "credentials",
    "options",
    "queue",
    "port",
    "accounting"
  ],
  "clock": [
    "tick-accounting",
    "resync-deadline",
    "realtime-before-monotonic"
  ],
  "persistence": [
    "not-quiesced",
    "policy",
    "bounds",
    "revision",
    "state"
  ],
  "workspace": [
    "not-quiesced",
    "policy",
    "revision"
  ],
  "scheduler": [
    "owner",
    "waiting",
    "worker-failure"
  ],
  "mapping": [
    "state",
    "reference",
    "bounds",
    "poisoned"
  ],
  "version": [
    "version"
  ],
  "image": [
    "image"
  ],
  "policy": [
    "policy"
  ],
  "bounds": [
    "bounds"
  ],
  "reference": [
    "reference"
  ],
  "state": [
    "state"
  ],
  "clock-read": [
    {
      "kind": "scalar",
      "name": "errno",
      "scalar": "errno"
    }
  ],
  "filesystem": [
    {
      "kind": "scalar",
      "name": "errno",
      "scalar": "errno"
    }
  ],
  "host": [
    "bounds",
    "reference",
    "state",
    "generation",
    "asset",
    {
      "kind": "child",
      "name": "memory",
      "node": "memory"
    }
  ],
  "keyring": [
    "identity",
    "description",
    "quota",
    "charge",
    {
      "kind": "child",
      "name": "cgroup",
      "node": "cgroup"
    }
  ],
  "process": [
    "allocator",
    "identity",
    "limits",
    "oom",
    "credentials",
    "terminal",
    "files",
    "namespace",
    "host",
    "keyring",
    "bounds",
    "graph",
    "missing-lease",
    {
      "kind": "child",
      "name": "cpu",
      "node": "cpu"
    },
    {
      "kind": "child",
      "name": "cgroup",
      "node": "cgroup"
    },
    {
      "kind": "child",
      "name": "signals",
      "node": "signals"
    },
    {
      "kind": "child",
      "name": "security",
      "node": "seccomp"
    },
    "ambiguous-legacy-membarrier",
    "legacy-io-uring-workers-missing",
    { "kind": "child", "name": "io-uring-workers", "node": "io-uring-workers" },
    "ambiguous-legacy-io-uring-cpu-group"
  ],
  "proc": [
    "bounds",
    "arguments",
    "inode",
    {
      "kind": "child",
      "name": "process",
      "node": "process"
    },
    {
      "kind": "child",
      "name": "cgroup",
      "node": "cgroup"
    },
    {
      "kind": "child",
      "name": "memory",
      "node": "memory"
    }
  ],
  "collections": [
    "bounds",
    "reference",
    "state",
    "execution",
    "namespace",
    {
      "kind": "child",
      "name": "process",
      "node": "process"
    },
    {
      "kind": "child",
      "name": "proc",
      "node": "proc"
    },
    {
      "kind": "child",
      "name": "cgroup",
      "node": "cgroup"
    },
    {
      "kind": "child",
      "name": "signal",
      "node": "signals"
    }
  ],
  "files": [
    "bounds",
    "reference",
    "state",
    "not-quiesced",
    "poisoned",
    {
      "kind": "child",
      "name": "memory",
      "node": "memory"
    },
    {
      "kind": "child",
      "name": "filesystem",
      "node": "vfs"
    },
    {
      "kind": "child",
      "name": "process",
      "node": "process"
    },
    {
      "kind": "child",
      "name": "proc",
      "node": "proc"
    },
    {
      "kind": "child",
      "name": "namespace",
      "node": "namespace"
    },
    {
      "kind": "child",
      "name": "cgroup",
      "node": "cgroup"
    },
    {
      "kind": "child",
      "name": "pipe",
      "node": "pipe"
    },
    {
      "kind": "child",
      "name": "pty",
      "node": "pty"
    },
    {
      "kind": "child",
      "name": "event",
      "node": "event"
    },
    {
      "kind": "child",
      "name": "unix",
      "node": "unix"
    },
    {
      "kind": "child",
      "name": "inet",
      "node": "inet"
    },
    {
      "kind": "child",
      "name": "netlink",
      "node": "netlink"
    },
    "legacy-copy-admission-missing",
    "legacy-signal-poll-source-missing",
    "legacy-creation-flag-missing",
    "legacy-splice-admission-missing"
  ],
  "file-operation": [
    {
      "kind": "child",
      "name": "files",
      "node": "files"
    },
    {
      "kind": "child",
      "name": "process",
      "node": "process"
    },
    {
      "kind": "child",
      "name": "host",
      "node": "host"
    },
    "state",
    "bounds",
    {
      "kind": "child",
      "name": "execution",
      "node": "execution"
    }
  ],
  "execution": [
    "bounds",
    "reference",
    "profile",
    {
      "kind": "child",
      "name": "machine",
      "node": "machine"
    },
    {
      "kind": "child",
      "name": "memory",
      "node": "memory"
    },
    {
      "kind": "child",
      "name": "mapping",
      "node": "mapping"
    }
  ],
  "machine": [
    "invalid-record",
    {
      "kind": "scalar",
      "name": "unsupported-version",
      "scalar": "version"
    },
    {
      "kind": "child",
      "name": "cpu",
      "node": "cpu"
    }
  ],
  "cpu": [
    "invalid-length",
    "invalid-magic",
    {
      "kind": "scalar",
      "name": "unsupported-version",
      "scalar": "version"
    },
    "invalid-reserved-field",
    {
      "kind": "scalar",
      "name": "invalid-field",
      "scalar": "cpu-field"
    },
    {
      "kind": "child",
      "name": "invalid-mode-transition",
      "node": "mode"
    }
  ],
  "mode": [
    "paging-without-protection",
    "long-mode-without-pae",
    {
      "kind": "scalar",
      "name": "reserved-control-register",
      "scalar": "control-register"
    }
  ]
};

const CPU_FIELDS = ["CPL", "CR8", "EFER", "MXCSR", "PAE PDPTE state", "PMU capability", "PMU", "RFLAGS", "SYSENTER_CS", "TSC_AUX", "TSS IST", "TSS RSP", "XINUSE", "XSAVE controls", "capability revision", "execution mode", "interrupt shadow", "mode", "profile", "x87 register", "Userspace TLS segment", "Userspace profile", "halted", "NMI blocked", "PAE PDPTE loaded"] as const;
const CONTROL_REGISTERS = ["CR0", "CR3", "CR4", "CR8"] as const;
const ERRNOS: Readonly<Record<number, string>> = {"1": "permission-denied", "2": "not-found", "3": "no-such-process", "4": "interrupted", "5": "io", "6": "no-device-or-address", "7": "argument-list-too-long", "8": "exec-format-error", "9": "bad-file-descriptor", "10": "no-child", "11": "try-again", "12": "out-of-memory", "13": "access-denied", "14": "fault", "16": "busy", "19": "no-device", "17": "already-exists", "18": "cross-device", "20": "not-directory", "21": "is-directory", "22": "invalid-argument", "24": "too-many-open-files", "25": "inappropriate-ioctl", "27": "file-too-large", "28": "no-space", "29": "illegal-seek", "32": "broken-pipe", "30": "read-only-file-system", "34": "range", "36": "name-too-long", "37": "no-locks", "38": "no-system-call", "39": "directory-not-empty", "40": "too-many-symlinks", "61": "no-data", "89": "destination-required", "90": "message-too-long", "91": "wrong-protocol", "92": "protocol-option-not-available", "93": "protocol-not-supported", "95": "operation-not-supported", "98": "address-in-use", "99": "address-not-available", "101": "network-unreachable", "104": "connection-reset", "105": "no-buffer-space", "106": "already-connected", "113": "host-unreachable", "107": "not-connected", "109": "too-many-references", "110": "timed-out", "111": "connection-refused", "114": "already-in-progress", "115": "in-progress", "122": "quota-exceeded", "126": "no-key"};

export function decodeOwnerPath(owner: string, low: number, high: number, scalar: number): readonly string[] {
  let path = BigInt(low) | BigInt(high) << 32n;
  let node = owner;
  const causes: string[] = [];
  for (let depth = 0; depth < 8; depth++) {
    const tag = Number(path & 0xffn); path >>= 8n;
    const variant = NODES[node]?.[tag - 1];
    if (tag === 0 || variant === undefined) invalid();
    if (typeof variant === "string") {
      if (path !== 0n || scalar !== 0) invalid();
      return [...causes, variant];
    }
    causes.push(variant.name);
    if (variant.kind === "child") { node = variant.node; continue; }
    if (path !== 0n) invalid();
    switch (variant.scalar) {
      case "version": if (scalar > 0xffff) invalid(); return causes;
      case "errno": {
        const name = ERRNOS[scalar]; if (name === undefined) invalid();
        return [...causes, name];
      }
      case "cpu-field": {
        const field = CPU_FIELDS[scalar - 1]; if (field === undefined) invalid();
        return [...causes, field];
      }
      case "control-register": {
        const register = CONTROL_REGISTERS[scalar - 1]; if (register === undefined) invalid();
        return [...causes, register];
      }
    }
  }
  return invalid();
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Native checkpoint failure frame is invalid"); }
