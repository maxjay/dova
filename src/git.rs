//! git, in the user's working tree, and the one thing dova stores there:
//! which work items a branch is for.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{Error, Result};
use crate::urls::unique;

pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub ok: bool,
}

/// Runs one git command; the seam tests replace.
pub type Runner = Box<dyn Fn(&[&str], &Path) -> Result<GitOutput> + Send + Sync>;

pub fn exec(args: &[&str], cwd: &Path) -> Result<GitOutput> {
    let out = Command::new("git").args(args).current_dir(cwd).output().map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => Error::prereq("git is not installed or not on PATH."),
        _ => Error::external(format!("Could not run git: {err}")),
    })?;
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        ok: out.status.success(),
    })
}

pub struct Git {
    runner: Runner,
    cwd: PathBuf,
}

impl Git {
    pub fn new(runner: Runner, cwd: PathBuf) -> Git {
        Git { runner, cwd }
    }

    /// Trimmed stdout; an error on a non-zero exit.
    pub fn run(&self, args: &[&str]) -> Result<String> {
        let out = (self.runner)(args, &self.cwd)?;
        if !out.ok {
            return Err(Error::external(format!("git {} failed:\n{}", args.join(" "), out.stderr.trim())));
        }
        Ok(out.stdout.trim_end().to_string())
    }

    /// Trimmed stdout, or None on a non-zero exit or empty output.
    pub fn try_run(&self, args: &[&str]) -> Result<Option<String>> {
        let out = (self.runner)(args, &self.cwd)?;
        let stdout = out.stdout.trim_end();
        Ok((out.ok && !stdout.is_empty()).then(|| stdout.to_string()))
    }

    pub fn is_repo(&self) -> Result<bool> {
        Ok(self.try_run(&["rev-parse", "--is-inside-work-tree"])?.as_deref() == Some("true"))
    }

    /// None on a detached HEAD or outside a repo.
    pub fn current_branch(&self) -> Result<Option<String>> {
        Ok(self.try_run(&["rev-parse", "--abbrev-ref", "HEAD"])?.filter(|branch| branch != "HEAD"))
    }

    pub fn remote_url(&self) -> Result<Option<String>> {
        self.try_run(&["remote", "get-url", "origin"])
    }

    /// The branch origin's HEAD points at, if the clone recorded it.
    pub fn origin_head(&self) -> Result<Option<String>> {
        let head = self.try_run(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?;
        Ok(head.map(|h| h.strip_prefix("origin/").unwrap_or(&h).to_string()))
    }

    pub fn has_ref(&self, name: &str) -> Result<bool> {
        Ok(self.try_run(&["rev-parse", "--verify", "--quiet", name])?.is_some())
    }

    /// A ref to read `branch` from: local, already fetched, or fetched now
    /// into a remote-tracking ref. Never checks anything out, so it works for
    /// someone else's PR without touching the working tree.
    pub fn readable_ref(&self, branch: &str) -> Result<String> {
        if self.has_ref(&format!("refs/heads/{branch}"))? {
            return Ok(branch.to_string());
        }
        let tracking = format!("refs/remotes/origin/{branch}");
        if !self.has_ref(&tracking)? {
            let fetched = (self.runner)(&["fetch", "origin", &format!("{branch}:{tracking}")], &self.cwd)?;
            if !fetched.ok {
                let err = Error::not_found(format!("No branch named \"{branch}\" locally or on origin."));
                return Err(match fetched.stderr.trim().lines().next() {
                    Some(said) => err.hint(format!("git fetch said: {said}")),
                    None => err,
                });
            }
        }
        Ok(format!("origin/{branch}"))
    }

    pub fn config_get(&self, key: &str) -> Result<Option<String>> {
        self.try_run(&["config", "--get", key])
    }

    pub fn config_set(&self, key: &str, value: &str) -> Result<()> {
        self.run(&["config", key, value]).map(drop)
    }

    pub fn config_unset(&self, key: &str) -> Result<()> {
        self.try_run(&["config", "--unset", key]).map(drop)
    }

    /// Every `(key, value)` whose key matches the regular expression.
    fn config_matching(&self, pattern: &str) -> Result<Vec<(String, String)>> {
        let out = self.try_run(&["config", "--get-regexp", pattern])?.unwrap_or_default();
        Ok(out.lines().filter_map(|line| line.split_once(' ')).map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }
}

/// Which work items a branch is for: the one thing dova records that neither
/// git nor Azure DevOps tracks. It lives in that branch's own git config,
/// next to its upstream:
///
///   branch.<name>.dova-workitems = 4821,4822
const LINKS: &str = "dova-workitems";

fn parse_ids(raw: &str) -> Vec<u64> {
    unique(raw.split(',').filter_map(|id| id.trim().parse().ok()).filter(|id| *id > 0))
}

impl Git {
    pub fn links(&self, branch: &str) -> Result<Vec<u64>> {
        Ok(parse_ids(&self.config_get(&format!("branch.{branch}.{LINKS}"))?.unwrap_or_default()))
    }

    /// Replaces the branch's links; none removes them.
    pub fn set_links(&self, branch: &str, ids: &[u64]) -> Result<()> {
        let key = format!("branch.{branch}.{LINKS}");
        if ids.is_empty() {
            return self.config_unset(&key);
        }
        let joined: Vec<String> = ids.iter().map(u64::to_string).collect();
        self.config_set(&key, &joined.join(","))
    }

    /// Every branch with links and what it links, in the order git config lists them.
    pub fn linked_branches(&self) -> Result<Vec<(String, Vec<u64>)>> {
        let entries = self.config_matching(r"^branch\..*\.dova-workitems$")?;
        let branch =
            |key: &str| key.strip_prefix("branch.")?.strip_suffix(LINKS)?.strip_suffix('.').map(str::to_string);
        let linked = entries.iter().filter_map(|(key, value)| Some((branch(key)?, parse_ids(value))));
        Ok(linked.filter(|(_, ids)| !ids.is_empty()).collect())
    }
}
