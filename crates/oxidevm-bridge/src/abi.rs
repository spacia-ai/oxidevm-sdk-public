//! The `oxidevm_bridge_v1` imports. This is the crate's only unsafe code: each call passes pointers
//! derived from live Rust values together with their lengths, and the host checks every range against linear memory
//! before it reads or writes anything. On targets other than wasm32 the functions report `NOSYS`, so the crate's pure
//! parts build and test natively.
#![allow(unsafe_code)]

/// WASI errno: function not supported.
pub(crate) const NOSYS: u32 = 52;
/// WASI errno: the native command's deadline passed.
pub(crate) const TIMEDOUT: u32 = 73;
/// WASI errno: the native command's output exceeded its limit.
pub(crate) const TOOBIG: u32 = 1;

#[cfg(target_arch = "wasm32")]
mod imports {
    #[link(wasm_import_module = "oxidevm_bridge_v1")]
    unsafe extern "C" {
        pub(crate) fn process_info(out: *mut u32) -> u32;
        pub(crate) fn process_cwd(buffer: *mut u8, len: u32, out_len: *mut u32) -> u32;
        pub(crate) fn command_run(
            request: *const u8,
            len: u32,
            out_handle: *mut u32,
            out_sizes: *mut u32,
        ) -> u32;
        pub(crate) fn result_status(handle: u32, out: *mut u32) -> u32;
        pub(crate) fn result_read(
            handle: u32,
            stream: u32,
            offset: u32,
            buffer: *mut u8,
            len: u32,
            out_read: *mut u32,
        ) -> u32;
        pub(crate) fn result_close(handle: u32) -> u32;
        pub(crate) fn net_connect(request: *const u8, len: u32, out_handle: *mut u32) -> u32;
        pub(crate) fn net_read(
            handle: u32,
            buffer: *mut u8,
            len: u32,
            timeout_ms: u32,
            out_read: *mut u32,
        ) -> u32;
        pub(crate) fn net_write(
            handle: u32,
            buffer: *const u8,
            len: u32,
            out_written: *mut u32,
        ) -> u32;
        pub(crate) fn net_shutdown(handle: u32, how: u32) -> u32;
        pub(crate) fn net_close(handle: u32) -> u32;
    }
}

/// `[pid, parent, uid, gid]`, or a WASI errno.
pub(crate) fn process_info() -> Result<[u32; 4], u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let mut out = [0_u32; 4];
        // SAFETY: `out` is a live, writable array of four u32 for the duration of the call.
        let errno = unsafe { imports::process_info(out.as_mut_ptr()) };
        if errno == 0 { Ok(out) } else { Err(errno) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Err(NOSYS)
    }
}

/// Copies the current directory into `buffer`; returns its full length (which may exceed the buffer), or a WASI errno.
pub(crate) fn process_cwd(buffer: &mut [u8]) -> Result<usize, u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let mut length = 0_u32;
        let capacity = u32::try_from(buffer.len()).map_err(|_| 28_u32)?;
        // SAFETY: `buffer` is writable for `capacity` bytes and `length` is a live u32, both for the call.
        let errno = unsafe { imports::process_cwd(buffer.as_mut_ptr(), capacity, &mut length) };
        if errno == 0 {
            usize::try_from(length).map_err(|_| 61_u32)
        } else {
            Err(errno)
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = buffer;
        Err(NOSYS)
    }
}

/// Runs an encoded command request; returns the result handle and the stdout and stderr sizes.
pub(crate) fn command_run(request: &[u8]) -> Result<(u32, [u32; 2]), u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let length = u32::try_from(request.len()).map_err(|_| 28_u32)?;
        let (mut handle, mut sizes) = (0_u32, [0_u32; 2]);
        // SAFETY: `request` is readable for `length` bytes; `handle` and `sizes` are live and writable for the call.
        let errno = unsafe {
            imports::command_run(request.as_ptr(), length, &mut handle, sizes.as_mut_ptr())
        };
        if errno == 0 {
            Ok((handle, sizes))
        } else {
            Err(errno)
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = request;
        Err(NOSYS)
    }
}

/// `[pid, kind, value]` of a finished command (kind 0 exited, 1 signaled).
pub(crate) fn result_status(handle: u32) -> Result<[u32; 3], u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let mut out = [0_u32; 3];
        // SAFETY: `out` is a live, writable array of three u32 for the call.
        let errno = unsafe { imports::result_status(handle, out.as_mut_ptr()) };
        if errno == 0 { Ok(out) } else { Err(errno) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = handle;
        Err(NOSYS)
    }
}

/// Copies retained output of `stream` (1 stdout, 2 stderr) from `offset`; returns the bytes copied.
pub(crate) fn result_read(
    handle: u32,
    stream: u32,
    offset: u32,
    buffer: &mut [u8],
) -> Result<usize, u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let capacity = u32::try_from(buffer.len()).map_err(|_| 28_u32)?;
        let mut read = 0_u32;
        // SAFETY: `buffer` is writable for `capacity` bytes and `read` is a live u32, both for the call.
        let errno = unsafe {
            imports::result_read(
                handle,
                stream,
                offset,
                buffer.as_mut_ptr(),
                capacity,
                &mut read,
            )
        };
        if errno == 0 {
            usize::try_from(read).map_err(|_| 61_u32)
        } else {
            Err(errno)
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (handle, stream, offset, buffer);
        Err(NOSYS)
    }
}

pub(crate) fn result_close(handle: u32) -> Result<(), u32> {
    #[cfg(target_arch = "wasm32")]
    {
        // SAFETY: no pointers cross this call.
        let errno = unsafe { imports::result_close(handle) };
        if errno == 0 { Ok(()) } else { Err(errno) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = handle;
        Err(NOSYS)
    }
}

pub(crate) fn net_connect(request: &[u8]) -> Result<u32, u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let length = u32::try_from(request.len()).map_err(|_| 28_u32)?;
        let mut handle = 0_u32;
        // SAFETY: `request` is readable for `length` bytes and `handle` is a live u32 for the call.
        let errno = unsafe { imports::net_connect(request.as_ptr(), length, &mut handle) };
        if errno == 0 { Ok(handle) } else { Err(errno) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = request;
        Err(NOSYS)
    }
}

pub(crate) fn net_read(handle: u32, buffer: &mut [u8], timeout_ms: u32) -> Result<usize, u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        let mut read = 0_u32;
        // SAFETY: `buffer` is writable for `capacity` bytes and `read` is a live u32 for the call.
        let errno = unsafe {
            imports::net_read(handle, buffer.as_mut_ptr(), capacity, timeout_ms, &mut read)
        };
        if errno == 0 {
            usize::try_from(read).map_err(|_| 61_u32)
        } else {
            Err(errno)
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (handle, buffer, timeout_ms);
        Err(NOSYS)
    }
}

pub(crate) fn net_write(handle: u32, buffer: &[u8]) -> Result<usize, u32> {
    #[cfg(target_arch = "wasm32")]
    {
        let length = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        let mut written = 0_u32;
        // SAFETY: `buffer` is readable for `length` bytes and `written` is a live u32 for the call.
        let errno = unsafe { imports::net_write(handle, buffer.as_ptr(), length, &mut written) };
        if errno == 0 {
            usize::try_from(written).map_err(|_| 61_u32)
        } else {
            Err(errno)
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (handle, buffer);
        Err(NOSYS)
    }
}

pub(crate) fn net_shutdown(handle: u32, how: u32) -> Result<(), u32> {
    #[cfg(target_arch = "wasm32")]
    {
        // SAFETY: no pointers cross this call.
        let errno = unsafe { imports::net_shutdown(handle, how) };
        if errno == 0 { Ok(()) } else { Err(errno) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (handle, how);
        Err(NOSYS)
    }
}

pub(crate) fn net_close(handle: u32) -> Result<(), u32> {
    #[cfg(target_arch = "wasm32")]
    {
        // SAFETY: no pointers cross this call.
        let errno = unsafe { imports::net_close(handle) };
        if errno == 0 { Ok(()) } else { Err(errno) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = handle;
        Err(NOSYS)
    }
}

/// Runs before `main` (wasm-ld collects `.init_array` into `__wasm_call_ctors`): WASI Preview1 has no working
/// directory, and wasi-libc starts every program at `/`, so the bridge moves it to the caller's real directory.
#[cfg(target_arch = "wasm32")]
#[used]
#[unsafe(link_section = ".init_array")]
static RESTORE_CWD: extern "C" fn() = restore_cwd;

#[cfg(target_arch = "wasm32")]
extern "C" fn restore_cwd() {
    if let Ok(cwd) = crate::process::cwd() {
        // A directory the program cannot enter leaves wasi-libc at `/`; `process::cwd()` still reports the real one.
        let _ = std::env::set_current_dir(cwd);
    }
}
