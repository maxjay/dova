//! The user's default Azure DevOps organization. Resolve its ID on setup,
//! then read the name and ID together from a local file.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde::{Deserialize, Serialize};

use crate::app::{App, Env};
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::urls;

#[derive(Serialize, Deserialize)]
pub struct Organization {
    pub name: String,
    pub id: String,
}

#[derive(Serialize, Deserialize)]
struct Settings {
    organization: Organization,
}

fn config_dir(env: &Env) -> Option<PathBuf> {
    let path = |key| env.get(key).map(PathBuf::from);
    path("DOVA_HOME").or_else(|| {
        let base = if cfg!(windows) {
            path("APPDATA").or_else(|| path("USERPROFILE").map(|home| home.join("AppData").join("Roaming")))
        } else {
            path("XDG_CONFIG_HOME").or_else(|| path("HOME").map(|home| home.join(".config")))
        };
        Some(base?.join("dova"))
    })
}

pub(crate) fn identity_file(env: &Env, org_url: &str) -> Option<PathBuf> {
    let org = org_url.strip_prefix("https://dev.azure.com/").filter(|name| valid_name(name))?;
    Some(config_dir(env)?.join(format!("user-id-{}.json", org.to_ascii_lowercase())))
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
        && id != "00000000-0000-0000-0000-000000000000"
}

pub fn saved_org(env: &Env) -> Result<Option<Organization>> {
    let Some(dir) = config_dir(env) else { return Ok(None) };
    let path = dir.join("config.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(Error::prereq(format!("Could not read {}: {err}", path.display()))),
    };
    let invalid = || {
        Error::user(format!("Invalid organization configuration in {}.", path.display()))
            .hint("Set it again with dova config set org <name>.")
    };
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let org = settings.organization;
    if !valid_name(&org.name) || !valid_id(&org.id) {
        return Err(invalid());
    }
    Ok(Some(org))
}

fn save(env: &Env, organization: Organization) -> Result<Organization> {
    let dir = config_dir(env).ok_or_else(|| Error::prereq("Could not find your configuration directory."))?;
    let path = dir.join("config.json");
    let write_error = |err: std::io::Error| Error::prereq(format!("Could not save {}: {err}", path.display()));
    let settings = Settings { organization };
    write_json(&path, &settings).map_err(write_error)?;
    Ok(settings.organization)
}

/// Replace one complete record, including when another Dova process is reading it.
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("Missing configuration directory."))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer_pretty(&mut tmp, value)?;
    writeln!(tmp)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)?;
    Ok(())
}

#[derive(Subcommand)]
pub enum Config {
    /// Save a default
    #[command(subcommand)]
    Set(Set),
    /// Read a saved default
    #[command(subcommand)]
    Get(Get),
}

#[derive(Subcommand)]
pub enum Set {
    /// Look up an Azure DevOps organization by name and save its name and ID
    Org { name: String },
}

#[derive(Subcommand)]
pub enum Get {
    /// Show the saved organization and its ID
    Org,
}

impl Config {
    pub fn run(&self, app: &App) -> Result<Output> {
        let org = match self {
            Self::Set(Set::Org { name }) => {
                if !valid_name(name) {
                    return Err(Error::user("Pass an organization name, for example: dova config set org contoso"));
                }
                let data = app.ado(&urls::org_url(name)).connection_data()?;
                let id = data["instanceId"]
                    .as_str()
                    .filter(|id| valid_id(id))
                    .ok_or_else(|| Error::external("Azure DevOps did not return a valid organization ID."))?;
                save(&app.env, Organization { name: name.clone(), id: id.to_owned() })?
            }
            Self::Get(Get::Org) => saved_org(&app.env)?.ok_or_else(|| {
                Error::not_found("No default organization saved.").hint("Run: dova config set org <name>")
            })?,
        };
        Ok(Output::new(&org, format!("{} ({})", org.name, org.id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::ScopeHint;
    use crate::rpc::Invoker;
    use crate::testing::{cli, ok, Bed, GitOpts};
    use serde_json::json;

    const GUID: &str = "22a4eacf-9218-4ea5-8e00-f190bc6596ec";

    #[test]
    fn pr_list_reuses_the_identity_saved_by_setup_or_a_previous_list() {
        let home = tempfile::tempdir().unwrap();
        let env = Env([("DOVA_HOME".into(), home.path().display().to_string())].into());
        let bed = Bed::new(Box::new(|r| {
            if r.path.ends_with("/connectionData") {
                return ok(json!({"instanceId":GUID,"authenticatedUser":{"id":GUID}}));
            }
            assert!(r.path.ends_with("/git/pullrequests"));
            assert_eq!(r.query("searchCriteria.creatorId").as_deref(), Some(GUID));
            ok(json!({"value":[]}))
        }));
        let app = || App { env: env.clone(), ..bed.app() };
        assert_eq!(cli(app(), &["config", "set", "org", "contoso"]).code, 0);
        for org in ["Contoso", "another", "another"] {
            let mut client = app();
            client.flags.org = Some(org.into());
            assert_eq!(cli(client, &["pr", "list"]).code, 0);
        }
        assert_eq!(bed.ado.requests().iter().filter(|r| r.path.ends_with("/connectionData")).count(), 2);
    }

    #[test]
    fn lookup_saves_the_pair_once_and_failed_replacement_preserves_it() {
        let home = tempfile::tempdir().unwrap();
        let env = Env([("DOVA_HOME".to_owned(), home.path().display().to_string())].into());
        let bed = Bed::new(Box::new(|r| {
            assert!(r.path.ends_with("/connectionData"));
            let id = if r.raw.url.contains("/first-org/") { GUID } else { "invalid" };
            ok(json!({"instanceId": id}))
        }))
        .git(GitOpts::outside_a_repo());
        let app = || App { env: env.clone(), ..bed.app() };
        let expected = json!({"name":"first-org","id":GUID});
        assert_eq!(cli(app(), &["config", "get", "org"]).code, 2);
        assert_eq!(cli(app(), &["config", "set", "org", "first-org", "--json"]).json(), expected);
        let mut fresh = app();
        assert_eq!(fresh.org_url(None).unwrap(), "https://dev.azure.com/first-org");
        fresh.flags.project = Some("second-project".to_owned());
        assert_eq!(fresh.scope().unwrap().org, "first-org");
        assert_eq!(cli(fresh, &["config", "get", "org", "--json"]).json(), expected);
        assert_eq!(cli(app(), &["config", "set", "org", "bad/path"]).code, 1);
        assert_eq!(bed.ado.requests().len(), 1);
        assert_ne!(cli(app(), &["config", "set", "org", "unresolved"]).code, 0);
        assert_eq!(cli(app(), &["config", "get", "org", "--json"]).json(), expected);
    }

    #[test]
    fn an_explicit_org_environment_or_remote_overrides_the_saved_default() {
        let dir = tempfile::tempdir().unwrap();
        let env = Env([("DOVA_HOME".to_owned(), dir.path().display().to_string())].into());
        save(&env, Organization { name: "saved".into(), id: GUID.into() }).unwrap();
        let bed = Bed::new(Box::new(|_| panic!("resolving scope should be local")));
        let mut app = App { env, ..bed.app() };
        assert_eq!(app.scope().unwrap().org, "contoso");
        app.env.0.insert("DOVA_ORG".into(), "environment".into());
        assert_eq!(app.scope().unwrap().org, "environment");
        app.flags.org = Some("flag".into());
        assert_eq!(app.scope().unwrap().org, "flag");
        assert_eq!(app.org_url(Some("linked")).unwrap(), "https://dev.azure.com/linked");
    }

    #[test]
    fn rpc_reads_saved_config_and_routes_each_request_outside_a_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let env = Env([("DOVA_HOME".to_owned(), dir.path().display().to_string())].into());
        let bed = Bed::new(Box::new(|r| match r.path.as_str() {
            "/_apis/connectionData" => ok(json!({"instanceId": GUID})),
            "/_apis/projects" => ok(json!({"url": r.raw.url})),
            _ => None,
        }));
        let rpc = Invoker::new(env.clone(), ScopeHint::default(), bed.ado.clone());
        let call = |method, params: serde_json::Value| rpc.invoke(method, params.as_object().unwrap()).unwrap();
        assert_eq!(call("config.set.org", json!({"name":"saved"}))["id"], GUID);
        assert_eq!(call("config.get.org", json!({}))["name"], "saved");
        let params = json!({"path":"/_apis/projects", "cwd":dir.path()});
        assert_eq!(call("api", params.clone())["url"], "https://dev.azure.com/saved/_apis/projects?api-version=7.1");
        let flags = ScopeHint { org: Some("startup".into()), ..ScopeHint::default() };
        let rpc = Invoker::new(env, flags, bed.ado.clone());
        let url = |params: &serde_json::Value| rpc.invoke("api", params.as_object().unwrap()).unwrap()["url"].clone();
        assert_eq!(url(&params), "https://dev.azure.com/startup/_apis/projects?api-version=7.1");
        let mut params = params;
        params["org"] = json!("other");
        assert_eq!(url(&params), "https://dev.azure.com/other/_apis/projects?api-version=7.1");
        assert_eq!(bed.ado.requests().iter().filter(|r| r.path.ends_with("/connectionData")).count(), 1);
    }
}
