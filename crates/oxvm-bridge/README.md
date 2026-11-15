# oxvm-bridge

Linux integration for Rust programs that run as WebAssembly (`wasm32-wasip1`) inside an
[OXVM](https://oxvm.dev) virtual machine in the browser.

OXVM runs compiled `wasm32-wasip1` programs as real Linux processes of the VM: standard Rust I/O, files, arguments,
environment, clocks and randomness work through WASI on the VM's live files. WASI Preview1 has no processes, no sockets
and no working directory; this crate adds them:

| API | What it does |
| --- | --- |
| `process::info()` | The program's real process id, parent, user and group in the VM |
| `process::cwd()` | The directory the program was started in (linking the crate also moves `std::env::current_dir` there before `main`) |
| `process::Command` | Runs a native Linux program with binary input and output, a deadline and output limits; the child is killed if your program ends first |
| `net::TcpStream`, `net::UnixStream` | Client connections on the VM's sockets, with TLS verified by the VM; both implement `std::io::Read` and `Write` |

```toml
[dependencies]
oxvm-bridge = "0.1.0"
```

```rust,no_run
use oxvm_bridge::process::{Command, ExitStatus};
use std::io::{Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new("/bin/gzip").args(["-n", "-c"]).input(*b"hello\n").output()?;
    assert_eq!(output.status, ExitStatus::Exited(0));
    std::fs::write("hello.gz", &output.stdout)?; // relative to the directory the program was started in

    let mut db = oxvm_bridge::net::TcpStream::connect("127.0.0.1", 5432)?;
    db.write_all(b"ping")?;
    let mut reply = Vec::new();
    db.read_to_end(&mut reply)?;
    Ok(())
}
```

Build with `cargo build --release --target wasm32-wasip1` and run the `.wasm` file in a VM, for example with the
`rust-wasi` command of the `oxidevm-rust` module, or from your own module with the SDK's `host.kit.wasi`.

The program's module must declare the capabilities a call uses: `process.info` for `process::info`, `process.sync` for
`Command`, and `net.vm` or `net.internet` for sockets. A call the module does not provide returns
`Error::Unavailable` (`io::ErrorKind::Unsupported` for sockets). Outside OXVM every call returns that error, so code
using the crate also builds and tests natively.

Guide: <https://oxvm.dev/docs/guides/rust-programs/> · Interface reference:
<https://oxvm.dev/docs/reference/wasi-bridge/>

`oxvm-bridge` imports `oxvm_bridge_v1` and requires the matching OXVM SDK.
The SDK also serves the retained `oxidevm_bridge_v1` namespace through the same v1
implementation, so previously compiled programs still work. Function signatures
and records retain ABI major 1. Its only unsafe code is those calls, in one module.

Licensed under the Apache License, Version 2.0.
