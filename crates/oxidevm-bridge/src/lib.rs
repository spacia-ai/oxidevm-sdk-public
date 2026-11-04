//! Linux integration for Rust programs that run as WebAssembly (`wasm32-wasip1`) inside an
//! [OxideVM](https://oxidevm.dev) virtual machine.
//!
//! An OxideVM module runs your compiled program with the SDK's `host.kit.wasi`: standard Rust I/O, files, arguments,
//! environment, clocks and randomness work through WASI on the VM's live Linux files. WASI Preview1 has no processes,
//! no sockets and no working directory, so this crate adds them through the `oxidevm_bridge_v1` imports the kit serves:
//!
//! - [`process::info`] and [`process::cwd`]: the program's real Linux identity in the VM and the directory it was
//!   started in. Linking this crate also moves `std::env::current_dir` to that directory before `main`, so relative
//!   paths resolve as they would for a native program.
//! - [`process::Command`]: runs a native Linux program (an absolute path, no shell) with binary input and output, a
//!   deadline and output limits; the child is killed if this program ends first.
//! - [`net::TcpStream`] and [`net::UnixStream`]: client connections on the VM's own sockets under the module's declared
//!   network reach, with TLS verified against the VM's trust store. Both implement [`std::io::Read`] and
//!   [`std::io::Write`].
//!
//! Outside OxideVM (or when the module does not declare the capability a call needs) every call returns
//! [`Error::Unavailable`], so the crate also builds and tests natively.
//!
//! ```no_run
//! use oxidevm_bridge::process::{Command, ExitStatus};
//! use std::time::Duration;
//!
//! fn main() -> Result<(), oxidevm_bridge::Error> {
//!     let me = oxidevm_bridge::process::info()?;
//!     let output = Command::new("/bin/gzip")
//!         .args(["-n", "-c"])
//!         .input(*b"compressed by native gzip\n")
//!         .timeout(Duration::from_secs(5))
//!         .output()?;
//!     assert_eq!(output.status, ExitStatus::Exited(0));
//!     println!("pid {} ran gzip as pid {}: {} bytes", me.pid, output.pid, output.stdout.len());
//!     Ok(())
//! }
//! ```
mod abi;
mod command;
pub mod net;
pub mod process;

use std::fmt;

/// Why a bridge call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The host answered with a WASI errno.
    Host(u32),
    /// The host is not running this program under the bridge (`NOSYS`), for example outside OxideVM.
    Unavailable,
    /// The host's answer broke the ABI.
    Protocol(&'static str),
    /// A command request broke a bound and was not started.
    InvalidCommand(&'static str),
    /// The child ran past its deadline and was killed.
    TimedOut,
    /// The child wrote more than its output limit and was killed.
    OutputLimit,
}

impl Error {
    fn from_errno(errno: u32) -> Self {
        match errno {
            abi::NOSYS => Self::Unavailable,
            abi::TIMEDOUT => Self::TimedOut,
            abi::TOOBIG => Self::OutputLimit,
            other => Self::Host(other),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Host(errno) => write!(f, "the OxideVM host failed with WASI errno {errno}"),
            Self::Unavailable => f.write_str("the OxideVM bridge is not available to this program"),
            Self::Protocol(reason) => write!(f, "the OxideVM bridge broke its ABI: {reason}"),
            Self::InvalidCommand(reason) => write!(f, "invalid native command: {reason}"),
            Self::TimedOut => {
                f.write_str("the native command ran past its deadline and was killed")
            }
            Self::OutputLimit => {
                f.write_str("the native command exceeded its output limit and was killed")
            }
        }
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_oxidevm_every_call_is_unavailable() {
        assert_eq!(process::info(), Err(Error::Unavailable));
        assert_eq!(process::cwd(), Err(Error::Unavailable));
    }

    #[test]
    fn errors_name_their_cause() {
        assert_eq!(Error::from_errno(8), Error::Host(8));
        assert!(Error::Unavailable.to_string().contains("not available"));
        assert!(
            Error::Protocol("x")
                .to_string()
                .contains("broke its ABI: x")
        );
    }
}
