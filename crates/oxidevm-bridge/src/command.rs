//! Native Linux programs, run to completion by the VM with piped, binary standard streams. Each child belongs to this
//! process: it is killed and reaped when its deadline passes and when this process ends for any reason.
use crate::{Error, abi};
use std::io::Write;
use std::time::Duration;

/// How a native child ended. Never squeezed into the module's own 0..119 exit range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitStatus {
    /// The child exited with this status (0 to 255).
    Exited(u8),
    /// A signal ended the child (its number, for example 9 for SIGKILL).
    Signaled(u8),
}

impl ExitStatus {
    /// Whether the child exited with status 0.
    pub fn success(self) -> bool {
        self == Self::Exited(0)
    }
}

/// A finished native child: its real VM pid, how it ended, and its complete output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    /// The child's process id in the VM.
    pub pid: u32,
    /// How it ended.
    pub status: ExitStatus,
    /// Everything it wrote to standard output.
    pub stdout: Vec<u8>,
    /// Everything it wrote to standard error.
    pub stderr: Vec<u8>,
}

/// The most arguments after the program (argv is at most 64 strings).
pub const MAX_ARGS: usize = 63;
/// The most bytes of standard input.
pub const MAX_INPUT: usize = 5 * 1024 * 1024;
/// The most bytes kept of each output stream.
pub const MAX_OUTPUT: usize = 1024 * 1024;
/// The longest deadline.
pub const MAX_TIMEOUT: Duration = Duration::from_secs(180);

/// A native program to run. There is no shell and no PATH lookup: `program` is an absolute path.
#[derive(Clone, Debug)]
pub struct Command {
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<Vec<(String, String)>>,
    input: Vec<u8>,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
}

impl Command {
    /// `program` must be absolute, as `execve` takes it.
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: None,
            input: Vec::new(),
            timeout: Duration::from_secs(30),
            stdout_limit: MAX_OUTPUT,
            stderr_limit: MAX_OUTPUT,
        }
    }
    /// Adds one argument.
    pub fn arg(&mut self, arg: impl Into<String>) -> &mut Self {
        self.args.push(arg.into());
        self
    }
    /// Adds several arguments.
    pub fn args<I: IntoIterator<Item = S>, S: Into<String>>(&mut self, args: I) -> &mut Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }
    /// The child's working directory; by default this process's.
    pub fn current_dir(&mut self, dir: impl Into<String>) -> &mut Self {
        self.cwd = Some(dir.into());
        self
    }
    /// Sets one variable; the rest of this process's environment is inherited.
    pub fn env(&mut self, key: impl Into<String>, value: impl Into<String>) -> &mut Self {
        let (key, value) = (key.into(), value.into());
        let env = self.env.get_or_insert_with(|| std::env::vars().collect());
        env.retain(|(existing, _)| *existing != key);
        env.push((key, value));
        self
    }
    /// Starts the child with an empty environment.
    pub fn env_clear(&mut self) -> &mut Self {
        self.env = Some(Vec::new());
        self
    }
    /// Bytes fed to the child's standard input, which is then closed.
    pub fn input(&mut self, bytes: impl Into<Vec<u8>>) -> &mut Self {
        self.input = bytes.into();
        self
    }
    /// The longest the child may run (1 ms to 180 s); then it is killed and `output` fails with `TimedOut`.
    pub fn timeout(&mut self, timeout: Duration) -> &mut Self {
        self.timeout = timeout;
        self
    }
    /// The most bytes kept of each output stream (at most 1 MiB); more ends the child and fails with `OutputLimit`.
    pub fn output_limits(&mut self, stdout: usize, stderr: usize) -> &mut Self {
        self.stdout_limit = stdout;
        self.stderr_limit = stderr;
        self
    }

    fn encode(&self) -> Result<Vec<u8>, Error> {
        let bad = |reason: &'static str| Err(Error::InvalidCommand(reason));
        if !self.program.starts_with('/') {
            return bad("the program must be an absolute path");
        }
        if self.args.len() > MAX_ARGS {
            return bad("at most 63 arguments");
        }
        let strings = std::iter::once(&self.program)
            .chain(&self.args)
            .chain(self.cwd.iter());
        let env = self
            .env
            .iter()
            .flatten()
            .flat_map(|(key, value)| [key, value]);
        if strings.chain(env).any(|text| text.contains('\0')) {
            return bad("an argument, directory or variable contains NUL");
        }
        if self
            .env
            .iter()
            .flatten()
            .any(|(key, _)| key.is_empty() || key.contains('='))
        {
            return bad("an environment name is empty or contains =");
        }
        if self.input.len() > MAX_INPUT {
            return bad("input exceeds 5 MiB");
        }
        if self.timeout.is_zero() || self.timeout > MAX_TIMEOUT {
            return bad("the timeout must be 1 ms to 180 s");
        }
        if self.stdout_limit > MAX_OUTPUT || self.stderr_limit > MAX_OUTPUT {
            return bad("an output limit exceeds 1 MiB");
        }
        let mut out = Vec::new();
        let put = |out: &mut Vec<u8>, bytes: &[u8]| {
            out.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_le_bytes());
            out.extend_from_slice(bytes);
        };
        put(&mut out, self.program.as_bytes());
        out.extend_from_slice(
            &u32::try_from(self.args.len())
                .unwrap_or(u32::MAX)
                .to_le_bytes(),
        );
        for arg in &self.args {
            put(&mut out, arg.as_bytes());
        }
        match &self.cwd {
            Some(cwd) => {
                out.push(1);
                put(&mut out, cwd.as_bytes());
            }
            None => out.push(0),
        }
        match &self.env {
            Some(env) => {
                out.push(1);
                out.extend_from_slice(&u32::try_from(env.len()).unwrap_or(u32::MAX).to_le_bytes());
                for (key, value) in env {
                    put(&mut out, format!("{key}={value}").as_bytes());
                }
            }
            None => out.push(0),
        }
        put(&mut out, &self.input);
        let millis = u32::try_from(self.timeout.as_millis())
            .unwrap_or(u32::MAX)
            .max(1);
        for value in [millis, self.stdout_limit as u32, self.stderr_limit as u32] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        Ok(out)
    }

    /// Runs the child to completion and returns its output.
    pub fn output(&self) -> Result<Output, Error> {
        let request = self.encode()?;
        let (handle, sizes) = abi::command_run(&request).map_err(Error::from_errno)?;
        let result = Result_ { handle };
        let [pid, kind, value] = abi::result_status(handle).map_err(Error::from_errno)?;
        let status = match (kind, u8::try_from(value)) {
            (0, Ok(code)) => ExitStatus::Exited(code),
            (1, Ok(signal)) => ExitStatus::Signaled(signal),
            _ => return Err(Error::Protocol("the host reported an invalid child status")),
        };
        let stdout = result.read(1, sizes[0])?;
        let stderr = result.read(2, sizes[1])?;
        drop(result);
        Ok(Output {
            pid,
            status,
            stdout,
            stderr,
        })
    }

    /// Runs the child, then writes its output to this program's own standard output and error (whatever the program
    /// redirected them to) and returns how it ended.
    pub fn status(&self) -> Result<ExitStatus, Error> {
        let output = self.output()?;
        std::io::stdout()
            .write_all(&output.stdout)
            .map_err(|_| Error::Protocol("writing the child's output failed"))?;
        std::io::stderr()
            .write_all(&output.stderr)
            .map_err(|_| Error::Protocol("writing the child's errors failed"))?;
        Ok(output.status)
    }
}

/// A retained result on the host, released when dropped.
struct Result_ {
    handle: u32,
}

impl Result_ {
    fn read(&self, stream: u32, size: u32) -> Result<Vec<u8>, Error> {
        let mut bytes = vec![0_u8; size as usize];
        let mut offset = 0_usize;
        while offset < bytes.len() {
            let chunk = bytes
                .get_mut(offset..)
                .ok_or(Error::Protocol("output offset out of range"))?;
            let read = abi::result_read(self.handle, stream, offset as u32, chunk)
                .map_err(Error::from_errno)?;
            if read == 0 {
                return Err(Error::Protocol(
                    "the host returned less output than it reported",
                ));
            }
            offset += read;
        }
        Ok(bytes)
    }
}

impl Drop for Result_ {
    fn drop(&mut self) {
        let _ = abi::result_close(self.handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_bad_requests_before_any_host_call() {
        let check = |command: &Command| command.encode().err();
        assert_eq!(
            check(&Command::new("gzip")),
            Some(Error::InvalidCommand(
                "the program must be an absolute path"
            ))
        );
        assert!(check(Command::new("/bin/x").args((0..64).map(|i| i.to_string()))).is_some());
        assert!(check(Command::new("/bin/x").args((0..63).map(|i| i.to_string()))).is_none());
        assert!(check(Command::new("/bin/x").arg("a\0b")).is_some());
        assert!(check(Command::new("/bin/x").env("A=B", "c")).is_some());
        assert!(check(Command::new("/bin/x").input(vec![0; MAX_INPUT + 1])).is_some());
        assert!(check(Command::new("/bin/x").timeout(Duration::ZERO)).is_some());
        assert!(check(Command::new("/bin/x").timeout(MAX_TIMEOUT)).is_none());
        assert!(
            check(Command::new("/bin/x").timeout(MAX_TIMEOUT + Duration::from_millis(1))).is_some()
        );
        assert!(check(Command::new("/bin/x").output_limits(MAX_OUTPUT + 1, 0)).is_some());
    }

    #[test]
    fn encodes_the_request_exactly() {
        let mut command = Command::new("/bin/gzip");
        command
            .arg("-c")
            .env_clear()
            .env("K", "v")
            .input(*b"\x00\xff")
            .timeout(Duration::from_millis(5))
            .output_limits(7, 8);
        let bytes = command.encode().unwrap_or_default();
        let mut want = Vec::new();
        want.extend_from_slice(&9_u32.to_le_bytes());
        want.extend_from_slice(b"/bin/gzip");
        want.extend_from_slice(&1_u32.to_le_bytes());
        want.extend_from_slice(&2_u32.to_le_bytes());
        want.extend_from_slice(b"-c");
        want.push(0);
        want.push(1);
        want.extend_from_slice(&1_u32.to_le_bytes());
        want.extend_from_slice(&3_u32.to_le_bytes());
        want.extend_from_slice(b"K=v");
        want.extend_from_slice(&2_u32.to_le_bytes());
        want.extend_from_slice(b"\x00\xff");
        for value in [5_u32, 7, 8] {
            want.extend_from_slice(&value.to_le_bytes());
        }
        assert_eq!(bytes, want);
    }

    #[test]
    fn outside_oxidevm_running_is_unavailable() {
        assert_eq!(Command::new("/bin/true").output(), Err(Error::Unavailable));
    }
}
