//! Azure DevOps URLs: the web links dova prints, and the links and git
//! remotes it accepts as input.

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use url::Url;

/// Everything but what JavaScript's `encodeURIComponent` leaves alone.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// One path segment or query value, percent-encoded.
pub fn enc(value: &str) -> String {
    utf8_percent_encode(value, COMPONENT).to_string()
}

pub fn org_url(org: &str) -> String {
    format!("https://dev.azure.com/{org}")
}

pub fn work_item_url(org_url: &str, project: &str, id: u64) -> String {
    format!("{org_url}/{}/_workitems/edit/{id}", enc(project))
}

pub fn pull_request_url(org_url: &str, project: &str, repo: &str, id: u64) -> String {
    format!("{org_url}/{}/_git/{}/pullrequest/{id}", enc(project), enc(repo))
}

pub fn run_url(org_url: &str, project: &str, id: u64) -> String {
    format!("{org_url}/{}/_build/results?buildId={id}", enc(project))
}

pub fn looks_like_url(value: &str) -> bool {
    let v = value.trim().to_ascii_lowercase();
    v.starts_with("http://") || v.starts_with("https://")
}

/// A bare positive integer, optionally written `#123`. None for anything else.
pub fn parse_id(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    let digits = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|id| *id > 0)
}

/// The ids once each, in the order first seen.
pub fn unique(ids: impl IntoIterator<Item = u64>) -> Vec<u64> {
    let mut seen = Vec::new();
    for id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

/// `git@host:path` (scp-style SSH) becomes a URL, so every remote form parses the same way.
fn to_url(raw: &str) -> Option<Url> {
    let s = raw.trim();
    if !s.contains("://") {
        if let Some((user, rest)) = s.split_once('@') {
            if let Some((host, path)) = rest.split_once(':') {
                let plain = |part: &str| !part.is_empty() && !part.contains(['/', ' ', '\t']);
                if plain(user) && plain(host) && !path.is_empty() {
                    return Url::parse(&format!("ssh://{user}@{host}/{path}")).ok();
                }
            }
        }
    }
    Url::parse(s).ok()
}

/// The organization a URL is in, and the path segments after it
/// (and after DefaultCollection on visualstudio.com).
fn org_path(url: &Url) -> Option<(String, Vec<String>)> {
    let host = url.host_str()?.to_ascii_lowercase();
    let mut segments: Vec<String> = url
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| percent_decode_str(s).decode_utf8_lossy().into_owned())
        .collect();
    if host == "dev.azure.com" {
        if segments.is_empty() {
            return None;
        }
        let org = segments.remove(0);
        return Some((org, segments));
    }
    if host == "ssh.dev.azure.com" {
        // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
        if segments.len() < 2 || segments[0] != "v3" {
            return None;
        }
        let org = segments.remove(1);
        segments.remove(0);
        return Some((org, segments));
    }
    let org = host.strip_suffix(".visualstudio.com")?;
    if org.is_empty() || org.contains('.') {
        return None;
    }
    if segments.first().is_some_and(|s| s.eq_ignore_ascii_case("defaultcollection")) {
        segments.remove(0);
    }
    Some((org.to_string(), segments))
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteRepo {
    pub org: String,
    pub project: String,
    pub repo: String,
}

/// An Azure Repos git remote, in any form Azure DevOps hands out:
///   https://dev.azure.com/{org}/{project}/_git/{repo}
///   https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
///   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
/// None for anything else (a GitHub remote, say).
pub fn parse_remote(raw: &str) -> Option<RemoteRepo> {
    let url = to_url(raw)?;
    let (org, rest) = org_path(&url)?;
    let strip = |name: &str| name.strip_suffix(".git").unwrap_or(name).to_string();

    if url.host_str()?.eq_ignore_ascii_case("ssh.dev.azure.com") {
        return match rest.as_slice() {
            [project, repo, ..] => Some(RemoteRepo { org, project: project.clone(), repo: strip(repo) }),
            _ => None,
        };
    }
    let git = rest.iter().position(|s| s == "_git").filter(|at| *at >= 1)?;
    let repo = rest.get(git + 1)?;
    Some(RemoteRepo { org, project: rest[..git].join("/"), repo: strip(repo) })
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkItemLink {
    pub org: String,
    pub project: String,
    pub id: u64,
}

/// `.../{project}/_workitems/edit/{id}` or `.../{project}/_workitems?id={id}`.
pub fn parse_work_item_link(raw: &str) -> Option<WorkItemLink> {
    let url = to_url(raw)?;
    let (org, rest) = org_path(&url)?;
    let at = rest.iter().position(|s| s == "_workitems").filter(|at| *at >= 1)?;
    let id = match &rest[at + 1..] {
        [edit, id, ..] if edit == "edit" => parse_id(id),
        _ => url.query_pairs().find(|(k, _)| k == "id").and_then(|(_, v)| parse_id(&v)),
    }?;
    Some(WorkItemLink { org, project: rest[..at].join("/"), id })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PullRequestLink {
    pub org: String,
    pub project: String,
    pub repo: String,
    pub id: u64,
}

/// `.../{project}/_git/{repo}/pullrequest/{id}`.
pub fn parse_pull_request_link(raw: &str) -> Option<PullRequestLink> {
    let url = to_url(raw)?;
    let (org, rest) = org_path(&url)?;
    let git = rest.iter().position(|s| s == "_git").filter(|at| *at >= 1)?;
    match &rest[git + 1..] {
        [repo, kind, id, ..] if kind == "pullrequest" => {
            Some(PullRequestLink { org, project: rest[..git].join("/"), repo: repo.clone(), id: parse_id(id)? })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_form_of_azure_repos_remote() {
        for (remote, project) in [
            ("https://dev.azure.com/contoso/MyProject/_git/web", "MyProject"),
            ("https://contoso@dev.azure.com/contoso/My%20Project/_git/web.git", "My Project"),
            ("git@ssh.dev.azure.com:v3/contoso/MyProject/web", "MyProject"),
            ("https://contoso.visualstudio.com/DefaultCollection/MyProject/_git/web", "MyProject"),
            ("https://contoso.visualstudio.com/MyProject/_git/web", "MyProject"),
        ] {
            let want = RemoteRepo { org: "contoso".into(), project: project.into(), repo: "web".into() };
            assert_eq!(parse_remote(remote), Some(want), "{remote}");
        }
    }

    #[test]
    fn remote_is_none_for_anything_that_is_not_azure_repos() {
        assert_eq!(parse_remote("git@github.com:contoso/web.git"), None);
        assert_eq!(parse_remote("https://dev.azure.com/contoso/MyProject"), None);
    }

    #[test]
    fn reads_both_work_item_link_forms() {
        let want = Some(WorkItemLink { org: "contoso".into(), project: "MyProject".into(), id: 42 });
        assert_eq!(parse_work_item_link("https://dev.azure.com/contoso/MyProject/_workitems/edit/42"), want);
        assert_eq!(parse_work_item_link("https://dev.azure.com/contoso/MyProject/_workitems?id=42"), want);
    }

    #[test]
    fn reads_a_pull_request_link() {
        assert_eq!(
            parse_pull_request_link("https://dev.azure.com/contoso/MyProject/_git/web/pullrequest/7"),
            Some(PullRequestLink { org: "contoso".into(), project: "MyProject".into(), repo: "web".into(), id: 7 })
        );
        assert_eq!(parse_pull_request_link("https://dev.azure.com/contoso/MyProject/_workitems/edit/7"), None);
    }

    #[test]
    fn takes_ids_bare_or_with_a_hash_and_nothing_else() {
        assert_eq!([parse_id("12"), parse_id("#12"), parse_id("0"), parse_id("12a")], [Some(12), Some(12), None, None]);
    }
}
