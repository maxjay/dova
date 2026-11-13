//! dovad: a long-running process that holds the az token in memory and
//! keeps connections to Azure DevOps open, making every request for the
//! CLI. Started by the first command that needs it; runs until stopped. It
//! speaks newline-delimited JSON over a user-only Unix socket (a named
//! pipe on Windows):
//!
//!   → { id, method, params }      ← { id, result } | { id, error }
//!
//! Who may connect is the operating system's call: the socket is in a
//! directory only its owner can enter, and Windows opens a pipe for writing
//! only to the user who made it. A daemon from another build of dova is
//! replaced.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use interprocess::local_socket::traits::{ListenerExt as _, Stream as _};
use interprocess::local_socket::{GenericFilePath, Listener, ListenerOptions, Name, Stream, ToFsName};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ado::auth::{AutoLogin, Session};
use crate::ado::{AuthStatus, Request, Response, Transport};
use crate::app::Env;
use crate::error::{Error, Result};
use crate::text::{iso8601, now_secs};

#[derive(Debug, Clone)]
pub struct Paths {
    pub dir: PathBuf,
    /// A socket file, or on Windows a pipe name.
    pub socket: String,
    pub log: PathBuf,
}

/// Where the daemon lives: `$DOVA_HOME`, else the platform's place for app state.
pub fn paths(env: &Env) -> Paths {
    let home = |var: &str| PathBuf::from(env.get(var).unwrap_or("."));
    let dir = match env.get("DOVA_HOME") {
        Some(dir) => PathBuf::from(dir),
        None if cfg!(windows) => env
            .get("LOCALAPPDATA")
            .map_or_else(|| home("USERPROFILE").join("AppData").join("Local"), PathBuf::from)
            .join("dova"),
        None => env
            .get("XDG_STATE_HOME")
            .map_or_else(|| home("HOME").join(".local").join("state"), PathBuf::from)
            .join("dova"),
    };
    // FNV-1a: only to tell one home's daemon from another's.
    let hash = dir
        .to_string_lossy()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    let hash = format!("{:012x}", hash & 0xffff_ffff_ffff);

    #[cfg(windows)]
    let socket = format!(r"\\.\pipe\dova-{}-{hash}", env.get("USERNAME").unwrap_or("user"));
    #[cfg(unix)]
    let socket = {
        // Unix socket paths max out around 104 bytes; a deep home goes past that.
        // SAFETY: getuid has no preconditions and cannot fail.
        let short = || format!("/tmp/dova-{}-{hash}/dovad.sock", unsafe { libc::getuid() });
        Some(dir.join("dovad.sock").to_string_lossy().into_owned()).filter(|s| s.len() <= 100).unwrap_or_else(short)
    };
    Paths { log: dir.join("daemon.log"), dir, socket }
}

/// Version plus the executable's own timestamp, so a rebuild counts as a different build too.
pub fn build_id() -> String {
    let modified = std::env::current_exe().and_then(std::fs::metadata).and_then(|meta| meta.modified()).ok();
    let stamp = modified.and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    format!("{}+{stamp}", env!("CARGO_PKG_VERSION"))
}

fn socket_name(socket: &str) -> std::io::Result<Name<'_>> {
    socket.to_fs_name::<GenericFilePath>()
}

fn reachable(socket: &str) -> bool {
    socket_name(socket).and_then(Stream::connect).is_ok()
}

/* ---------------- wire ---------------- */

#[derive(Serialize, Deserialize)]
struct Call {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize, Deserialize)]
struct Reply {
    id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<Error>,
}

/// One connection, read by one thread and written to by many.
struct Wire {
    stream: Stream,
    writing: Mutex<()>,
}

impl Wire {
    fn new(stream: Stream) -> Arc<Wire> {
        Arc::new(Wire { stream, writing: Mutex::new(()) })
    }

    fn lines(&self) -> impl Iterator<Item = String> + '_ {
        BufReader::new(&self.stream).lines().map_while(|line| line.ok())
    }

    fn write(&self, message: &impl Serialize) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(message)?;
        line.push(b'\n');
        let _one_at_a_time = self.writing.lock().unwrap();
        (&self.stream).write_all(&line)
    }
}

/* ---------------- server ---------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub pid: u32,
    pub build: String,
    pub started_at: String,
    pub requests: u64,
    pub socket: String,
    pub log: String,
}

struct Server {
    paths: Paths,
    session: Session,
    started_at: String,
    requests: AtomicU64,
    /// Also print the log to stderr: `dova daemon run` in a terminal.
    echo: bool,
}

/// A running daemon. Dropping it leaves it running; `wait` stays with it.
pub struct Daemon {
    accepting: thread::JoinHandle<()>,
}

impl Daemon {
    pub fn wait(self) {
        let _ = self.accepting.join();
    }
}

/// Starts serving on `paths`. Binding the socket is the single-instance lock.
pub fn serve(paths: Paths, session: Session, echo: bool) -> Result<Daemon> {
    prepare_dirs(&paths)?;
    let listener = bind(&paths)?;
    let server =
        Arc::new(Server { paths, session, started_at: iso8601(now_secs()), requests: AtomicU64::new(0), echo });
    server.log(&format!("dova daemon {} listening on {}", build_id(), server.paths.socket));
    let accepting = thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let server = server.clone();
            thread::spawn(move || server.converse(conn));
        }
    });
    Ok(Daemon { accepting })
}

fn bind(paths: &Paths) -> Result<Listener> {
    let listen = || ListenerOptions::new().name(socket_name(&paths.socket)?).create_sync();
    listen()
        .or_else(|err| {
            if reachable(&paths.socket) {
                return Err(Error::prereq("Another dova daemon is already running."));
            }
            // A dead daemon's leftover socket file.
            if cfg!(unix) && std::fs::remove_file(&paths.socket).is_ok() {
                return listen().map_err(|err| Error::prereq(format!("Could not listen on {}: {err}", paths.socket)));
            }
            Err(Error::prereq(format!("Could not listen on {}: {err}", paths.socket)))
        })
        .and_then(|listener| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))?;
            }
            Ok(listener)
        })
}

/// The daemon's directories exist, are this user's, and are closed to everyone else.
fn prepare_dirs(paths: &Paths) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        for dir in [Some(paths.dir.as_path()), Path::new(&paths.socket).parent()].into_iter().flatten() {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
            let meta = std::fs::symlink_metadata(dir)?;
            // In a shared /tmp, someone else could have made it first.
            // SAFETY: getuid has no preconditions and cannot fail.
            if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
                return Err(Error::prereq(format!("{} is not a directory of yours.", dir.display())));
            }
            if meta.mode() & 0o077 != 0 {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    #[cfg(windows)]
    std::fs::create_dir_all(&paths.dir)?;
    Ok(())
}

impl Server {
    fn status(&self) -> DaemonStatus {
        DaemonStatus {
            pid: std::process::id(),
            build: build_id(),
            started_at: self.started_at.clone(),
            requests: self.requests.load(Ordering::Relaxed),
            socket: self.paths.socket.clone(),
            log: self.paths.log.display().to_string(),
        }
    }

    fn log(&self, line: &str) {
        let entry = format!("{} {line}\n", iso8601(now_secs()));
        // Its directory is the user's alone, so the log is too.
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).create(true).open(&self.paths.log) {
            let _ = file.write_all(entry.as_bytes());
        }
        if self.echo {
            eprint!("{entry}");
        }
    }

    /// One client connection: calls, each answered on its own thread.
    fn converse(self: Arc<Self>, conn: Stream) {
        let wire = Wire::new(conn);
        for line in wire.lines() {
            let Ok(call) = serde_json::from_str::<Call>(&line) else { break };
            let (server, wire) = (self.clone(), wire.clone());
            thread::spawn(move || {
                let reply = match server.handle(&call.method, call.params) {
                    Ok(result) => Reply { id: call.id, result: Some(result), error: None },
                    Err(err) => Reply { id: call.id, result: None, error: Some(err) },
                };
                let _ = wire.write(&reply);
                if call.method == "daemon.stop" {
                    server.stop();
                }
            });
        }
    }

    fn handle(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "ado.request" => {
                let req: Request =
                    serde_json::from_value(params).map_err(|err| Error::user(format!("Not a request: {err}")))?;
                let started = Instant::now();
                self.requests.fetch_add(1, Ordering::Relaxed);
                // The path only, never the query string.
                let path = url::Url::parse(&req.url).map_or_else(|_| "?".to_string(), |url| url.path().to_string());
                let sent = self.session.send(&req);
                match &sent {
                    Ok(res) => self.log(&format!(
                        "{} {path} {} {}ms",
                        req.method.as_str(),
                        res.status,
                        started.elapsed().as_millis()
                    )),
                    Err(err) => self.log(&format!("{} {path} failed: {}", req.method.as_str(), err.message)),
                }
                Ok(json!(sent?))
            }
            "auth.status" => Ok(json!(self.session.status())),
            "daemon.status" => Ok(json!(self.status())),
            "daemon.stop" => Ok(Value::Null),
            other => Err(Error::user(format!("Unknown method {other}"))),
        }
    }

    fn stop(&self) -> ! {
        self.log("stopping");
        if cfg!(unix) {
            let _ = std::fs::remove_file(&self.paths.socket);
        }
        std::process::exit(0)
    }
}

/* ---------------- client ---------------- */

#[derive(Default)]
struct Pending {
    waiting: HashMap<u64, mpsc::Sender<Reply>>,
    closed: bool,
}

/// One connection to the daemon, shared by every thread of this process.
pub struct Client {
    wire: Arc<Wire>,
    pending: Arc<Mutex<Pending>>,
    next: AtomicU64,
}

fn lost() -> Error {
    Error::prereq("Lost the connection to the dova daemon.").hint("Check: dova daemon status")
}

impl Client {
    /// A connection to the daemon that's running, and what it says about itself. None when none is.
    pub fn open(paths: &Paths) -> Option<(Client, DaemonStatus)> {
        let wire = Wire::new(Stream::connect(socket_name(&paths.socket).ok()?).ok()?);
        let pending = Arc::new(Mutex::new(Pending::default()));
        let (replies, reading) = (pending.clone(), wire.clone());
        thread::spawn(move || {
            for line in reading.lines() {
                let Ok(reply) = serde_json::from_str::<Reply>(&line) else { break };
                if let Some(waiting) = replies.lock().unwrap().waiting.remove(&reply.id) {
                    let _ = waiting.send(reply);
                }
            }
            // Dropping the senders wakes every caller still waiting.
            let mut replies = replies.lock().unwrap();
            replies.closed = true;
            replies.waiting.clear();
        });
        let client = Client { wire, pending, next: AtomicU64::new(1) };
        let status = client.call("daemon.status", Value::Null).ok()?;
        Some((client, status))
    }

    pub fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, waiting) = mpsc::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.closed {
                return Err(lost());
            }
            pending.waiting.insert(id, reply);
        }
        self.wire.write(&Call { id, method: method.to_string(), params }).map_err(|_| lost())?;
        let reply = waiting.recv().map_err(|_| lost())?;
        if let Some(err) = reply.error {
            return Err(err);
        }
        serde_json::from_value(reply.result.unwrap_or(Value::Null))
            .map_err(|err| Error::unexpected(format!("The dova daemon answered {method} with something else: {err}")))
    }

    fn is_closed(&self) -> bool {
        self.pending.lock().unwrap().closed
    }

    /// Asks the daemon to stop, and waits until it's gone and its executable is free again.
    pub fn stop(self, paths: &Paths) {
        // It exits as it answers, so the answer may never arrive.
        let _ = self.call::<Value>("daemon.stop", Value::Null);
        wait_for(|| !reachable(&paths.socket));
    }
}

fn wait_for(mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    false
}

/// The running daemon, started — or replaced, if it's from another build — as needed.
pub fn connect(paths: &Paths) -> Result<Client> {
    if let Some((client, status)) = Client::open(paths) {
        if status.build == build_id() {
            return Ok(client);
        }
        client.stop(paths);
    }
    spawn_detached()?;
    let mut opened = None;
    wait_for(|| {
        opened = Client::open(paths);
        opened.is_some()
    });
    let could_not = || {
        Error::prereq("Could not start the dova daemon.")
            .hint(format!("See {}", paths.log.display()))
            .hint("Or skip it: DOVA_NO_DAEMON=1")
    };
    opened.map(|(client, _)| client).ok_or_else(could_not)
}

/// `dova daemon run`, cut loose from this command so it outlives it.
fn spawn_detached() -> Result<()> {
    let exe = std::env::current_exe()
        .map_err(|_| Error::prereq("Cannot tell how dova was started, so cannot start its daemon."))?;
    detach(&exe).map_err(|err| Error::prereq(format!("Could not start the dova daemon: {err}")))
}

/// Its own session, so closing the terminal doesn't take it along; no stdio; and not sitting in anyone's directory.
#[cfg(unix)]
fn detach(exe: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let mut daemon = std::process::Command::new(exe);
    daemon.args(["daemon", "run"]).current_dir("/");
    daemon.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe, and is all that runs between fork and exec.
    unsafe {
        daemon.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    daemon.spawn().map(drop)
}

/// A Windows child inherits every inheritable handle its parent holds, not
/// only its stdio — including the pipe someone is reading this command's
/// output from, which would then never close. `std::process` always asks
/// for that inheritance, so the daemon is created directly, inheriting nothing.
#[cfg(windows)]
fn detach(exe: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let wide = |text: &std::ffi::OsStr| text.encode_wide().chain([0]).collect::<Vec<u16>>();
    let program = wide(exe.as_os_str());
    let mut command_line = wide(format!("\"{}\" daemon run", exe.display()).as_ref());
    // Not the caller's directory, which Windows would keep locked for as long as the daemon runs.
    let directory = wide(std::env::temp_dir().as_os_str());
    // SAFETY: both structs are plain data for which all zeroes is a valid value.
    let (mut startup, mut process): (STARTUPINFOW, PROCESS_INFORMATION) =
        unsafe { (std::mem::zeroed(), std::mem::zeroed()) };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    // SAFETY: every pointer is null or points at a NUL-terminated buffer or struct that outlives the call.
    let created = unsafe {
        CreateProcessW(
            program.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            0, // inherit no handles
            CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            null(),
            directory.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both handles were just handed to us and are closed exactly once.
    unsafe {
        CloseHandle(process.hProcess);
        CloseHandle(process.hThread);
    }
    Ok(())
}

/* ---------------- transports ---------------- */

/// Through the daemon; or, with `DOVA_NO_DAEMON=1`, from this process with a
/// fresh az token every command. Nothing connects until the first request.
pub fn transport(env: &Env, interactive: bool) -> Arc<dyn Transport> {
    let login = AutoLogin::new(interactive);
    if env.is_on("DOVA_NO_DAEMON") {
        Arc::new(InProcess { session: Session::from_az(), login })
    } else {
        Arc::new(ViaDaemon { paths: paths(env), client: Mutex::new(None), login })
    }
}

struct InProcess {
    session: Session,
    login: AutoLogin,
}

impl Transport for InProcess {
    fn kind(&self) -> &'static str {
        "in-process"
    }

    fn send(&self, req: &Request) -> Result<Response> {
        self.login.run(|| self.session.send(req))
    }

    fn auth_status(&self) -> Result<AuthStatus> {
        Ok(self.session.status())
    }
}

struct ViaDaemon {
    paths: Paths,
    client: Mutex<Option<Arc<Client>>>,
    login: AutoLogin,
}

impl ViaDaemon {
    /// The connection, made on first use and again if the daemon went away.
    fn client(&self) -> Result<Arc<Client>> {
        let mut client = self.client.lock().unwrap();
        if let Some(open) = client.as_ref().filter(|c| !c.is_closed()) {
            return Ok(open.clone());
        }
        let fresh = Arc::new(connect(&self.paths)?);
        *client = Some(fresh.clone());
        Ok(fresh)
    }
}

impl Transport for ViaDaemon {
    fn kind(&self) -> &'static str {
        "daemon"
    }

    fn send(&self, req: &Request) -> Result<Response> {
        self.login.run(|| self.client()?.call("ado.request", json!(req)))
    }

    fn auth_status(&self) -> Result<AuthStatus> {
        self.client()?.call("auth.status", Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ado::auth::TokenSource;
    use crate::error::Kind;

    /// A daemon in this process, on its own socket, whose az has nobody logged in: no az, no network.
    fn start() -> (Paths, tempfile::TempDir) {
        let home = tempfile::tempdir().unwrap();
        let paths = paths(&Env([("DOVA_HOME".to_string(), home.path().to_string_lossy().into_owned())].into()));
        let nobody: TokenSource = Box::new(|_| Err(Error::not_signed_in("Not logged in to Azure CLI.", None)));
        let unreachable = Box::new(|_: &Request, _: &str| Err(Error::external("no network in tests")));
        serve(paths.clone(), Session::new(nobody, unreachable, None), false).unwrap();
        (paths, home)
    }

    #[test]
    #[cfg(unix)]
    fn is_private_to_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let (paths, _home) = start();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(Path::new(&paths.socket)), 0o600);
        assert_eq!(mode(&paths.dir), 0o700);
    }

    #[test]
    fn answers_several_calls_at_once_on_one_connection() {
        let (paths, _home) = start();
        let (client, status) = Client::open(&paths).unwrap();
        assert_eq!(status.pid, std::process::id());
        let (daemon, auth) = crate::par::join(
            || client.call::<DaemonStatus>("daemon.status", Value::Null),
            || client.call::<AuthStatus>("auth.status", Value::Null),
        );
        assert_eq!(daemon.unwrap().pid, std::process::id());
        assert!(!auth.unwrap().signed_in);
    }

    #[test]
    fn hands_back_errors_as_they_were_so_the_cli_can_run_az_login() {
        let (paths, _home) = start();
        let (client, _) = Client::open(&paths).unwrap();
        let req = Request::get("https://dev.azure.com/contoso/_apis/x?secret=1");
        let err = client.call::<Response>("ado.request", json!(req)).unwrap_err();
        assert_eq!((err.kind, err.exit_code()), (Kind::NotSignedIn, 3));
        assert_eq!(err.hints, ["Run: az login"]);
        let log = std::fs::read_to_string(&paths.log).unwrap();
        assert!(log.contains("GET /contoso/_apis/x failed") && !log.contains("secret"), "{log}");
    }

    #[test]
    fn refuses_to_start_twice_on_one_socket() {
        let (paths, _home) = start();
        let nobody: TokenSource = Box::new(|_| Err(Error::prereq("unused")));
        let again = serve(paths, Session::new(nobody, Box::new(|_, _| Err(Error::external("unused"))), None), false);
        assert_eq!(again.err().map(|e| e.message).as_deref(), Some("Another dova daemon is already running."));
    }

    #[test]
    fn keeps_the_tenant_of_a_sign_in_error_across_the_wire() {
        let wire = serde_json::to_string(&Error::not_signed_in("x", Some("guest"))).unwrap();
        let back: Error = serde_json::from_str(&wire).unwrap();
        assert_eq!((back.kind, back.tenant.as_deref()), (Kind::NotSignedIn, Some("guest")));
        let newer: Error = serde_json::from_str(r#"{"kind":"something_new","message":"x"}"#).unwrap();
        assert_eq!(newer, Error::unexpected("x"));
    }

    #[test]
    #[cfg(unix)]
    fn puts_a_socket_that_would_be_too_long_somewhere_short() {
        let home = format!("/home/j/{}dova", "deep/".repeat(25));
        let paths = paths(&Env([("DOVA_HOME".to_string(), home)].into()));
        assert!(paths.socket.starts_with("/tmp/dova-") && paths.socket.ends_with("/dovad.sock"), "{}", paths.socket);
    }
}
