//! Requests signed with the user's own `az login`. az is asked for a token
//! once and it's kept until near expiry, per tenant. A new `az login` is
//! noticed from az's profile file changing; an org in another tenant names
//! it in its 401, and gets a token from there.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde_json::Value;
use url::Url;

use super::{AuthStatus, Method, Request, Response};
use crate::error::{Error, Kind, Result};
use crate::text::{iso8601, now_secs};

/// Azure DevOps, as an Entra resource.
const RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";
/// A token this close to expiring is replaced before use.
const MARGIN_SECS: u64 = 5 * 60;
const INSTALL_AZ: &str = "Install: https://learn.microsoft.com/cli/azure/install-azure-cli";

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: u64,
}

/// A token for a tenant, or for az's default one.
pub type TokenSource = Box<dyn Fn(Option<&str>) -> Result<Token> + Send + Sync>;

/// Sends one request with a bearer token. Returns the response and the
/// tenant the organization says it belongs to, when it says.
pub type Fetch = Box<dyn Fn(&Request, &str) -> Result<(Response, Option<String>)> + Send + Sync>;

#[derive(Default)]
struct State {
    tokens: HashMap<String, Token>,
    org_tenants: HashMap<String, String>,
    profile_stamp: Option<SystemTime>,
}

pub struct Session {
    source: TokenSource,
    fetch: Fetch,
    /// az's profile file: `az login`, `az logout` and `az account set` all rewrite it.
    profile: Option<PathBuf>,
    state: Mutex<State>,
}

impl Session {
    pub fn new(source: TokenSource, fetch: Fetch, profile: Option<PathBuf>) -> Session {
        Session { source, fetch, profile, state: Mutex::default() }
    }

    /// The real thing: tokens from `az`, requests over HTTPS.
    pub fn from_az() -> Session {
        let config = std::env::var_os("AZURE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join(".azure")));
        Session::new(Box::new(az_token), https(), config.map(|dir| dir.join("azureProfile.json")))
    }

    pub fn send(&self, req: &Request) -> Result<Response> {
        let url = Url::parse(&req.url).map_err(|_| Error::user(format!("\"{}\" isn't a URL.", req.url)))?;
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        let azure = host == "dev.azure.com" || host.ends_with(".dev.azure.com") || host.ends_with(".visualstudio.com");
        if url.scheme() != "https" || !azure || !url.username().is_empty() {
            return Err(Error::user(format!(
                "dova only sends requests to Azure DevOps, not {}.",
                url.origin().ascii_serialization()
            )));
        }
        self.forget_tokens_if_az_login_changed();
        let org = match host.strip_suffix(".visualstudio.com") {
            Some(org) => org.to_string(),
            None => url.path_segments().and_then(|mut s| s.next()).unwrap_or("").to_string(),
        };
        let tenant = self.state.lock().unwrap().org_tenants.get(&org).cloned().unwrap_or_default();

        let refused = |res: &Response| res.status == 401 || res.status == 203;
        let (res, wanted, token) = self.signed(req, &tenant, None)?;
        if !refused(&res) {
            return Ok(res);
        }
        // The org is in another tenant than the token's: get one there.
        if let Some(wanted) = wanted.filter(|w| claims(&token)["tid"].as_str() != Some(w.as_str())) {
            self.state.lock().unwrap().org_tenants.insert(org, wanted.clone());
            return Ok(self.signed(req, &wanted, None)?.0);
        }
        // Otherwise the token itself may have gone bad: once more with a new one.
        Ok(self.signed(req, &tenant, Some(&token))?.0)
    }

    /// The token requests to this organization go out with.
    pub fn token_for(&self, org: &str) -> Result<String> {
        self.forget_tokens_if_az_login_changed();
        let tenant = self.state.lock().unwrap().org_tenants.get(org).cloned().unwrap_or_default();
        Ok(self.token(&tenant, None)?.access_token)
    }

    pub fn status(&self) -> AuthStatus {
        self.forget_tokens_if_az_login_changed();
        match self.token("", None) {
            Ok(token) => {
                let claims = claims(&token.access_token);
                let text = |key: &str| claims[key].as_str().map(str::to_string);
                AuthStatus {
                    signed_in: true,
                    account: text("upn").or_else(|| text("unique_name")),
                    tenant: text("tid"),
                    expires_at: Some(iso8601(token.expires_at)),
                    error: None,
                }
            }
            Err(err) => {
                AuthStatus { signed_in: false, account: None, tenant: None, expires_at: None, error: Some(err.message) }
            }
        }
    }

    fn signed(&self, req: &Request, tenant: &str, stale: Option<&str>) -> Result<(Response, Option<String>, String)> {
        let token = self.token(tenant, stale)?.access_token;
        let (res, wanted) = (self.fetch)(req, &token)?;
        Ok((res, wanted, token))
    }

    /// The cached token for a tenant, or a new one when there's none, it's
    /// about to expire, or it's the one (`stale`) that was just refused.
    /// The lock is held while az runs, so concurrent requests share one ask.
    fn token(&self, tenant: &str, stale: Option<&str>) -> Result<Token> {
        let mut state = self.state.lock().unwrap();
        if let Some(cached) = state.tokens.get(tenant) {
            if cached.expires_at > now_secs() + MARGIN_SECS && stale != Some(cached.access_token.as_str()) {
                return Ok(cached.clone());
            }
        }
        state.tokens.remove(tenant);
        let token = (self.source)(Some(tenant).filter(|t| !t.is_empty()))?;
        state.tokens.insert(tenant.to_string(), token.clone());
        Ok(token)
    }

    fn forget_tokens_if_az_login_changed(&self) {
        let Some(profile) = &self.profile else { return };
        let stamp = std::fs::metadata(profile).and_then(|m| m.modified()).ok();
        let mut state = self.state.lock().unwrap();
        if stamp != state.profile_stamp {
            state.tokens.clear();
        }
        state.profile_stamp = stamp;
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// A JWT's payload, unverified: only ever read to describe a token we were given.
fn claims(jwt: &str) -> Value {
    let payload = jwt.split('.').nth(1).unwrap_or("");
    let bytes =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).unwrap_or_default();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

/* ---------------- HTTPS ---------------- */

/// Logs can be large; anything past this is not a response dova asked for.
const MAX_BODY: u64 = 512 * 1024 * 1024;

/// How many requests are in flight at once over HTTP/1.1, where each needs
/// a connection of its own: what a browser allows itself per host. A
/// hundred new connections in a burst is what gets some of them reset.
const AT_ONCE: usize = 6;
/// Over HTTP/2 they all share one connection, which Azure DevOps lets carry
/// a hundred at a time.
const AT_ONCE_SHARED: usize = 64;

/// How often a read is asked again after its connection drops…
const RETRIES: u32 = 2;
/// …and how long it waits first, and twice as long the second time.
const PAUSE: Duration = Duration::from_millis(250);

/// Lets a set number of callers through at a time.
struct Gate {
    /// Places free, and how many there are in all.
    places: Mutex<(usize, usize)>,
    freed: Condvar,
}

/// A place through the gate, given back when dropped.
struct Pass<'a>(&'a Gate);

impl Gate {
    fn new(limit: usize) -> Gate {
        Gate { places: Mutex::new((limit, limit)), freed: Condvar::new() }
    }

    fn pass(&self) -> Pass<'_> {
        let mut places = self.places.lock().unwrap();
        while places.0 == 0 {
            places = self.freed.wait(places).unwrap();
        }
        places.0 -= 1;
        Pass(self)
    }

    /// Lets more through from now on; never fewer.
    fn widen(&self, limit: usize) {
        let mut places = self.places.lock().unwrap();
        if limit > places.1 {
            *places = (places.0 + limit - places.1, limit);
            self.freed.notify_all();
        }
    }
}

impl Drop for Pass<'_> {
    fn drop(&mut self) {
        self.0.places.lock().unwrap().0 += 1;
        self.0.freed.notify_one();
    }
}

/// Why one attempt at a request failed, and whether the same request might work if asked again.
struct Dropped {
    error: Error,
    again: bool,
}

/// `attempt`, repeated while it fails in a way worth repeating: up to `again` more times, a `pause` longer each time.
fn retried<T>(again: u32, pause: Duration, attempt: impl Fn() -> std::result::Result<T, Dropped>) -> Result<T> {
    let mut tried = 0;
    loop {
        match attempt() {
            Ok(done) => return Ok(done),
            Err(dropped) if dropped.again && tried < again => {
                tried += 1;
                std::thread::sleep(pause * tried);
            }
            Err(dropped) => return Err(dropped.error),
        }
    }
}

/// HTTPS with the system's certificates and proxy settings, over HTTP/2
/// where the other end speaks it (Azure DevOps does): every request shares
/// one connection, and the daemon keeps it between commands for as long
/// as the other end does. Azure DevOps closes one that has carried nothing
/// for a few minutes (measured: open at two, gone by five); the next
/// command then opens another, and nothing fails.
pub fn https() -> Fetch {
    // rustls wants its cryptography named once per process; a second naming is ignored.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(100))
        // Kept until the other end closes it, and pinged so that a dead one is noticed before it is used.
        .pool_idle_timeout(None)
        .pool_max_idle_per_host(AT_ONCE)
        .http2_keep_alive_interval(Duration::from_secs(30))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .user_agent(format!("dova/{}", env!("CARGO_PKG_VERSION")))
        .build();
    let gate = Gate::new(AT_ONCE);

    Box::new(move |req, token| {
        let client = client.as_ref().map_err(|err| Error::external(format!("Could not set up HTTPS: {err}")))?;
        let _pass = gate.pass();
        // Only a read is safe to ask twice: a write may have landed before its connection went.
        let again = if req.method == Method::Get { RETRIES } else { 0 };
        let (answer, shared) = retried(again, PAUSE, || exchange(client, req, token))?;
        if shared {
            gate.widen(AT_ONCE_SHARED);
        }
        Ok(answer)
    })
}

/// One request and its whole answer, and whether it came over a connection that requests share (HTTP/2).
fn exchange(
    client: &reqwest::blocking::Client,
    req: &Request,
    token: &str,
) -> std::result::Result<((Response, Option<String>), bool), Dropped> {
    let refused = |error: Error| Dropped { error, again: false };
    let invalid = || refused(Error::user(format!("\"{}\" isn't a request dova can send.", req.url)));
    let method = reqwest::Method::from_bytes(req.method.as_str().as_bytes()).map_err(|_| invalid())?;
    let mut builder = client
        .request(method, req.url.as_str())
        .bearer_auth(token)
        .header("Accept", if req.text { "text/plain" } else { "application/json" })
        // A 401 instead of a 203 sign-in page.
        .header("X-TFS-FedAuthRedirect", "Suppress");
    if let Some(content_type) = &req.content_type {
        builder = builder.header("Content-Type", content_type);
    }
    builder = match &req.body {
        Some(body) if req.base64 => builder.body(
            base64::engine::general_purpose::STANDARD
                .decode(body)
                .map_err(|_| refused(Error::user("That upload isn't base64.")))?,
        ),
        Some(body) => builder.body(body.clone()),
        None => builder,
    };
    let res = builder.send().map_err(|err| Dropped {
        // A connection that was reset or never made says nothing about the request itself.
        again: err.is_connect() || (err.is_request() && !err.is_timeout()),
        error: if err.is_builder() {
            invalid().error
        } else {
            Error::external(format!("Could not reach Azure DevOps: {}", cause(&err)))
        },
    })?;

    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    // All zeros means "no particular tenant".
    let wanted =
        header("x-vss-resourcetenant").and_then(|v| v.split(',').next().map(|t| t.trim().to_string())).filter(|t| {
            t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                && t.chars().any(|c| c != '0' && c != '-')
        });
    let (status, content_type) = (res.status().as_u16(), header("content-type"));
    let shared = res.version() == reqwest::Version::HTTP_2;
    let mut bytes = Vec::new();
    res.take(MAX_BODY + 1).read_to_end(&mut bytes).map_err(|err| Dropped {
        again: true,
        error: Error::external(format!("Azure DevOps' answer was cut short: {err}")),
    })?;
    if bytes.len() as u64 > MAX_BODY {
        return Err(refused(Error::external("Azure DevOps' answer is larger than anything dova asks for.")));
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok(((Response { status, content_type, body }, wanted), shared))
}

/// What is at the bottom of an error: reqwest's own text stops at "error
/// sending request", and the reason (refused, no such host, a bad
/// certificate) is the last thing under it.
fn cause(err: &dyn std::error::Error) -> String {
    let mut deepest = err;
    while let Some(under) = deepest.source() {
        deepest = under;
    }
    deepest.to_string()
}

/* ---------------- az ---------------- */

fn az(args: &[&str]) -> Command {
    // On Windows az is a batch file, which is only found by its full name.
    let mut command = Command::new(if cfg!(windows) { "az.cmd" } else { "az" });
    command.args(args);
    command
}

fn az_missing(err: std::io::Error) -> Error {
    match err.kind() {
        std::io::ErrorKind::NotFound => {
            Error::prereq("az (Azure CLI) is not installed or not on PATH.").hint(INSTALL_AZ)
        }
        _ => Error::prereq(format!("Could not run az: {err}")),
    }
}

pub fn az_token(tenant: Option<&str>) -> Result<Token> {
    let mut args = vec!["account", "get-access-token", "--resource", RESOURCE, "--output", "json"];
    if let Some(tenant) = tenant {
        args.extend(["--tenant", tenant]);
    }
    let out = az(&args).stdin(Stdio::null()).output().map_err(az_missing)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let said = stderr.to_ascii_lowercase();
        if ["az login", "aadsts", "expired", "refresh token", "interaction"].iter().any(|sign| said.contains(sign)) {
            return Err(match tenant {
                Some(t) => Error::not_signed_in(
                    format!("This organization belongs to tenant {t}, which your az login doesn't cover yet."),
                    Some(t),
                ),
                None => Error::not_signed_in("Not logged in to Azure CLI.", None),
            });
        }
        return Err(Error::prereq(format!("az could not get an Azure DevOps token: {stderr}")));
    }
    parse_az_token(&String::from_utf8_lossy(&out.stdout))
}

/// `expires_on` is Unix seconds, on az 2.54 and later. Without it the token
/// is assumed good for ten minutes, which only means asking az more often.
pub fn parse_az_token(stdout: &str) -> Result<Token> {
    let data: Value =
        serde_json::from_str(stdout).map_err(|_| Error::prereq("az returned something other than a token."))?;
    let access_token =
        data["accessToken"].as_str().ok_or_else(|| Error::prereq("az returned something other than a token."))?;
    let expires_at = data["expires_on"].as_u64().unwrap_or_else(|| now_secs() + 10 * 60);
    Ok(Token { access_token: access_token.to_string(), expires_at })
}

/// `az login` in this terminal, its output on stderr so stdout stays the command's.
pub fn az_login(tenant: Option<&str>) -> Result<()> {
    match tenant {
        Some(t) => eprintln!("Signing in to tenant {t}…"),
        None => eprintln!("Not signed in to Azure — running az login…"),
    }
    let mut args = vec!["login", "--output", "none"];
    if let Some(tenant) = tenant {
        args.extend(["--tenant", tenant]);
    }
    let status = az(&args).stdout(std::io::stderr()).status().map_err(az_missing)?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::prereq(format!("az login did not finish ({status}).")))
    }
}

/// Signs in to a tenant, or to az's default one: `az login`, outside tests.
pub type Login = Box<dyn Fn(Option<&str>) -> Result<()> + Send + Sync>;

/// In a terminal, "not signed in" becomes `az login` and another try:
/// once per tenant per process, shared by concurrent requests.
pub struct AutoLogin {
    interactive: bool,
    login: Login,
    done: Mutex<HashMap<String, Result<()>>>,
}

impl AutoLogin {
    pub fn new(interactive: bool) -> AutoLogin {
        AutoLogin::with(interactive, Box::new(az_login))
    }

    pub fn with(interactive: bool, login: Login) -> AutoLogin {
        AutoLogin { interactive, login, done: Mutex::default() }
    }

    pub fn run<T>(&self, attempt: impl Fn() -> Result<T>) -> Result<T> {
        let mut tried = HashSet::new();
        loop {
            let err = match attempt() {
                Ok(value) => return Ok(value),
                Err(err) => err,
            };
            let tenant = err.tenant.clone().unwrap_or_default();
            if err.kind != Kind::NotSignedIn || !self.interactive || !tried.insert(tenant.clone()) {
                return Err(err);
            }
            // Holding the lock makes everyone else wait for this login instead of starting their own.
            let mut done = self.done.lock().unwrap();
            let login = || (self.login)(Some(tenant.as_str()).filter(|t| !t.is_empty()));
            done.entry(tenant.clone()).or_insert_with(login).clone()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use serde_json::json;

    use super::*;

    fn jwt(claims: Value) -> String {
        format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    fn get() -> Request {
        Request::get("https://dev.azure.com/contoso/_apis/projects")
    }

    type Calls = Arc<Mutex<Vec<Option<String>>>>;
    type Seen = Arc<Mutex<Vec<Value>>>;

    /// az, handing out token n for the tenant asked (`home` by default), and recording each ask.
    fn fake_az(lifetime_secs: u64) -> (TokenSource, Calls) {
        let calls = Calls::default();
        let (n, log) = (AtomicUsize::new(0), calls.clone());
        let source: TokenSource = Box::new(move |tenant| {
            log.lock().unwrap().push(tenant.map(str::to_string));
            let n = n.fetch_add(1, Ordering::SeqCst) + 1;
            let claims = json!({ "n": n, "tid": tenant.unwrap_or("home"), "upn": "jane@contoso.com" });
            Ok(Token { access_token: jwt(claims), expires_at: now_secs() + lifetime_secs })
        });
        (source, calls)
    }

    /// Azure DevOps: answers with `answer(token claims)`, a status and optionally the org's tenant.
    fn fake_ado(answer: impl Fn(&Value) -> (u16, Option<&'static str>) + Send + Sync + 'static) -> (Fetch, Seen) {
        let seen = Seen::default();
        let log = seen.clone();
        let fetch: Fetch = Box::new(move |_, token| {
            let claims = claims(token);
            log.lock().unwrap().push(claims.clone());
            let (status, tenant) = answer(&claims);
            Ok((Response { status, content_type: None, body: "{}".into() }, tenant.map(str::to_string)))
        });
        (fetch, seen)
    }

    fn ns(seen: &Seen) -> Vec<u64> {
        seen.lock().unwrap().iter().map(|c| c["n"].as_u64().unwrap()).collect()
    }

    #[test]
    fn asks_az_once_shares_that_between_concurrent_requests_and_reuses_it() {
        let (az, calls) = fake_az(3600);
        let (ado, seen) = fake_ado(|_| (200, None));
        let s = Session::new(az, ado, None);
        let (a, b) = crate::par::join(|| s.send(&get()), || s.send(&get()));
        a.unwrap();
        b.unwrap();
        s.send(&get()).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(ns(&seen), [1, 1, 1]);
    }

    #[test]
    fn asks_again_when_the_token_is_close_to_expiring() {
        let (az, calls) = fake_az(60);
        let s = Session::new(az, fake_ado(|_| (200, None)).0, None);
        s.send(&get()).unwrap();
        s.send(&get()).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn gets_a_token_from_the_orgs_own_tenant_when_it_names_one_and_remembers_that() {
        let (az, calls) = fake_az(3600);
        let (ado, _) = fake_ado(|t| if t["tid"] == "guest" { (200, None) } else { (401, Some("guest")) });
        let s = Session::new(az, ado, None);
        assert_eq!(s.send(&get()).unwrap().status, 200);
        assert_eq!(s.send(&get()).unwrap().status, 200);
        assert_eq!(*calls.lock().unwrap(), [None, Some("guest".to_string())]);
    }

    #[test]
    fn retries_once_with_a_fresh_token_when_the_same_tenant_refuses_one() {
        let (az, _) = fake_az(3600);
        let (ado, seen) = fake_ado(|t| (if t["n"] == 1 { 401 } else { 200 }, None));
        assert_eq!(Session::new(az, ado, None).send(&get()).unwrap().status, 200);
        assert_eq!(ns(&seen), [1, 2]);
    }

    #[test]
    fn says_why_a_request_could_not_be_sent_not_just_that_it_could_not() {
        #[derive(Debug)]
        struct Layer(&'static str, Option<Box<Layer>>);
        impl std::fmt::Display for Layer {
            fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl std::error::Error for Layer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.1.as_deref().map(|under| under as &(dyn std::error::Error + 'static))
            }
        }
        let refused = Layer("connection refused", None);
        let sending = Layer("error sending request", Some(Box::new(Layer("tunnel error", Some(Box::new(refused))))));
        assert_eq!(cause(&sending), "connection refused");
        assert_eq!(cause(&Layer("timed out", None)), "timed out");
    }

    #[test]
    fn the_gate_never_lets_more_through_than_its_limit() {
        let gate = Gate::new(3);
        let (inside, most) = (AtomicUsize::new(0), AtomicUsize::new(0));
        std::thread::scope(|s| {
            for _ in 0..40 {
                s.spawn(|| {
                    let _pass = gate.pass();
                    most.fetch_max(inside.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(2));
                    inside.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        assert_eq!(most.load(Ordering::SeqCst), 3);
        assert_eq!(*gate.places.lock().unwrap(), (3, 3), "every pass was given back");

        // Once requests share a connection, more may go at once; it never narrows again.
        gate.widen(5);
        gate.widen(4);
        let held: Vec<_> = (0..5).map(|_| gate.pass()).collect();
        assert_eq!(*gate.places.lock().unwrap(), (0, 5));
        drop(held);
        assert_eq!(*gate.places.lock().unwrap(), (5, 5));
    }

    #[test]
    fn asks_again_only_when_asking_again_could_help_and_only_so_often() {
        let dropped = |again: bool| Dropped { error: Error::external("reset by peer"), again };
        let asked = AtomicUsize::new(0);
        let third_time_lucky = || match asked.fetch_add(1, Ordering::SeqCst) {
            0 | 1 => Err(dropped(true)),
            n => Ok(n),
        };
        assert_eq!(retried(2, Duration::ZERO, third_time_lucky).unwrap(), 2);

        // A write is never asked twice, and neither is anything that failed for a reason of its own.
        let asked = AtomicUsize::new(0);
        let count = |again: bool| {
            asked.store(0, Ordering::SeqCst);
            let failing = || -> std::result::Result<(), Dropped> {
                asked.fetch_add(1, Ordering::SeqCst);
                Err(dropped(again))
            };
            (retried(0, Duration::ZERO, failing).is_err(), asked.load(Ordering::SeqCst))
        };
        assert_eq!((count(true), count(false)), ((true, 1), (true, 1)));
        let always = || -> std::result::Result<(), Dropped> {
            asked.fetch_add(1, Ordering::SeqCst);
            Err(dropped(true))
        };
        asked.store(0, Ordering::SeqCst);
        assert_eq!(retried(2, Duration::ZERO, always).unwrap_err().message, "reset by peer");
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn notices_a_new_az_login_by_itself() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("azureProfile.json");
        std::fs::write(&profile, "{}").unwrap();
        let (az, _) = fake_az(3600);
        let (ado, seen) = fake_ado(|_| (200, None));
        let s = Session::new(az, ado, Some(profile.clone()));
        s.send(&get()).unwrap();
        let later = SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options().write(true).open(&profile).unwrap().set_modified(later).unwrap();
        s.send(&get()).unwrap();
        assert_eq!(ns(&seen), [1, 2]);
    }

    #[test]
    fn never_sends_the_token_outside_azure_devops() {
        let (az, calls) = fake_az(3600);
        let s = Session::new(az, fake_ado(|_| (200, None)).0, None);
        for url in [
            "https://evil.example/x",
            "https://dev.azure.com.evil.example/x",
            "http://dev.azure.com/contoso",
            "https://dev.azure.com@evil.example/x",
        ] {
            assert_eq!(s.send(&Request::get(url)).unwrap_err().kind, Kind::User, "{url}");
        }
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn reports_who_is_signed_in_or_why_not() {
        let status = Session::new(fake_az(3600).0, fake_ado(|_| (200, None)).0, None).status();
        assert_eq!(
            (status.signed_in, status.account.as_deref(), status.tenant.as_deref()),
            (true, Some("jane@contoso.com"), Some("home"))
        );

        let nobody: TokenSource = Box::new(|_| Err(Error::not_signed_in("Not logged in to Azure CLI.", None)));
        let status = Session::new(nobody, fake_ado(|_| (200, None)).0, None).status();
        assert_eq!((status.signed_in, status.error.as_deref()), (false, Some("Not logged in to Azure CLI.")));
    }

    #[test]
    fn reads_the_expiry_az_gives_and_survives_its_absence() {
        assert_eq!(parse_az_token(r#"{"accessToken":"t","expires_on":1800000000}"#).unwrap().expires_at, 1_800_000_000);
        let assumed =
            parse_az_token(r#"{"accessToken":"t","expiresOn":"2026-10-24 19:41:07.000000"}"#).unwrap().expires_at;
        assert!(assumed > now_secs() && assumed <= now_secs() + 600);
        assert_eq!(parse_az_token("WARNING").unwrap_err().kind, Kind::Prereq);
    }

    type Logins = Arc<Mutex<Vec<Option<String>>>>;

    fn recording_login(interactive: bool) -> (AutoLogin, Logins) {
        let logins = Logins::default();
        let log = logins.clone();
        let login: Login = Box::new(move |tenant| {
            log.lock().unwrap().push(tenant.map(str::to_string));
            Ok(())
        });
        let auto = AutoLogin::with(interactive, login);
        (auto, logins)
    }

    #[test]
    fn logs_in_once_for_concurrent_failures_then_follows_on_to_the_tenant_the_org_needs() {
        let (auto, logins) = recording_login(true);
        let attempt = || {
            let done = logins.lock().unwrap().clone();
            if !done.contains(&None) {
                return Err(Error::not_signed_in("no", None));
            }
            if !done.contains(&Some("guest".to_string())) {
                return Err(Error::not_signed_in("no", Some("guest")));
            }
            Ok(200)
        };
        let (a, b) = crate::par::join(|| auto.run(attempt), || auto.run(attempt));
        assert_eq!((a, b), (Ok(200), Ok(200)));
        assert_eq!(*logins.lock().unwrap(), [None, Some("guest".to_string())]);
    }

    #[test]
    fn without_a_terminal_or_for_any_other_error_passes_it_through() {
        let (auto, logins) = recording_login(false);
        assert_eq!(auto.run(|| Err::<(), _>(Error::not_signed_in("no", None))).unwrap_err().kind, Kind::NotSignedIn);
        let (auto, more) = recording_login(true);
        assert_eq!(auto.run(|| Err::<(), _>(Error::prereq("az missing"))).unwrap_err().kind, Kind::Prereq);
        assert!(logins.lock().unwrap().is_empty() && more.lock().unwrap().is_empty());
    }

    #[test]
    fn gives_up_rather_than_logging_in_to_the_same_tenant_twice() {
        let (auto, logins) = recording_login(true);
        assert_eq!(
            auto.run(|| Err::<(), _>(Error::not_signed_in("still no", None))).unwrap_err().kind,
            Kind::NotSignedIn
        );
        assert_eq!(logins.lock().unwrap().len(), 1);
    }
}
