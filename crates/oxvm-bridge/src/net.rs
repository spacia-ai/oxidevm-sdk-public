//! Client streams on this process's own VM sockets: TCP (optionally TLS, verified by the VM against its trust store) and
//! Unix sockets. The module's declared network reach applies; a write to a closed peer is an `io::Error` with
//! `BrokenPipe`, never a SIGPIPE.
use crate::abi;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::time::Duration;

const NO_TIMEOUT: u32 = u32::MAX;

/// WASI errno → the matching `io::ErrorKind`, so callers can match on it as on `std::net` errors.
fn io_error(errno: u32) -> io::Error {
    use io::ErrorKind::*;
    let kind = match errno {
        abi::NOSYS => Unsupported,
        2 | 63 => PermissionDenied,
        6 | 73 => TimedOut,
        13 => ConnectionAborted,
        14 => ConnectionRefused,
        15 => ConnectionReset,
        44 => NotFound,
        53 => NotConnected,
        64 => BrokenPipe,
        28 => InvalidInput,
        23 => HostUnreachable,
        40 => NetworkUnreachable,
        3 => AddrInUse,
        4 => AddrNotAvailable,
        _ => Other,
    };
    io::Error::new(kind, format!("VM socket failed with WASI errno {errno}"))
}

fn put(out: &mut Vec<u8>, text: &str) -> io::Result<()> {
    if text.is_empty() || text.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "empty name or NUL in a socket destination",
        ));
    }
    let length = u32::try_from(text.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination too long"))?;
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(text.as_bytes());
    Ok(())
}

/// One open connection handle; closed on drop.
#[derive(Debug)]
struct Socket {
    handle: u32,
    read_timeout: Option<Duration>,
}

impl Socket {
    fn connect(request: &[u8]) -> io::Result<Self> {
        abi::net_connect(request)
            .map(|handle| Self {
                handle,
                read_timeout: None,
            })
            .map_err(io_error)
    }
    fn timeout_ms(&self) -> u32 {
        self.read_timeout.map_or(NO_TIMEOUT, |timeout| {
            u32::try_from(timeout.as_millis())
                .unwrap_or(NO_TIMEOUT - 1)
                .clamp(1, NO_TIMEOUT - 1)
        })
    }
    fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        let how = match how {
            Shutdown::Read => 1,
            Shutdown::Write => 2,
            Shutdown::Both => 3,
        };
        abi::net_shutdown(self.handle, how).map_err(io_error)
    }
}

impl Read for Socket {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        abi::net_read(self.handle, buffer, self.timeout_ms()).map_err(io_error)
    }
}

impl Write for Socket {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        abi::net_write(self.handle, buffer).map_err(io_error)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Socket {
    fn drop(&mut self) {
        let _ = abi::net_close(self.handle);
    }
}

/// A TCP connection, optionally TLS.
#[derive(Debug)]
pub struct TcpStream(Socket);

impl TcpStream {
    /// Connects to `host:port` (a DNS name, resolved by the VM, or a numeric address).
    pub fn connect(host: &str, port: u16) -> io::Result<Self> {
        Self::open(0, host, port, &[])
    }
    /// Connects with TLS to `host`, verified against the VM's `/etc/ssl/cert.pem`; verification cannot be switched off.
    pub fn connect_tls(host: &str, port: u16, alpn: &[&str]) -> io::Result<Self> {
        Self::open(1, host, port, alpn)
    }
    fn open(kind: u8, host: &str, port: u16, alpn: &[&str]) -> io::Result<Self> {
        let mut request = vec![kind];
        put(&mut request, host)?;
        request.extend_from_slice(&port.to_le_bytes());
        if kind == 1 {
            let count = u32::try_from(alpn.len()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "too many ALPN protocols")
            })?;
            request.extend_from_slice(&count.to_le_bytes());
            for protocol in alpn {
                put(&mut request, protocol)?;
            }
        }
        Socket::connect(&request).map(Self)
    }
    /// How long a read may wait; `None` waits until bytes or the end of the stream arrive.
    /// How long a read may wait; `None` waits until bytes or the end of the stream arrive.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) {
        self.0.read_timeout = timeout;
    }
    /// Shuts down reading, writing or both; shutting down writing tells the peer this side is done.
    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        self.0.shutdown(how)
    }
}

impl Read for TcpStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}
impl Write for TcpStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A Unix stream socket connection in the VM.
#[derive(Debug)]
pub struct UnixStream(Socket);

impl UnixStream {
    /// Connects to the Unix socket at `path` in the VM.
    pub fn connect(path: &str) -> io::Result<Self> {
        let mut request = vec![2];
        put(&mut request, path)?;
        Socket::connect(&request).map(Self)
    }
    /// How long a read may wait; `None` waits until bytes or the end of the stream arrive.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) {
        self.0.read_timeout = timeout;
    }
    /// Shuts down reading, writing or both.
    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        self.0.shutdown(how)
    }
}

impl Read for UnixStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}
impl Write for UnixStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_keep_their_meaning() {
        assert_eq!(io_error(14).kind(), io::ErrorKind::ConnectionRefused);
        assert_eq!(io_error(44).kind(), io::ErrorKind::NotFound);
        assert_eq!(io_error(2).kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(io_error(64).kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(io_error(abi::NOSYS).kind(), io::ErrorKind::Unsupported);
    }

    #[test]
    fn refuses_bad_destinations_before_any_host_call() {
        assert_eq!(
            UnixStream::connect("")
                .map(|_| ())
                .map_err(|error| error.kind()),
            Err(io::ErrorKind::InvalidInput)
        );
        assert_eq!(
            TcpStream::connect("a\0b", 80)
                .map(|_| ())
                .map_err(|error| error.kind()),
            Err(io::ErrorKind::InvalidInput)
        );
        assert_eq!(
            TcpStream::connect("localhost", 80)
                .map(|_| ())
                .map_err(|error| error.kind()),
            Err(io::ErrorKind::Unsupported)
        );
    }
}
