//! `dova pr diff`: what a pull request changes, read from Azure DevOps
//! itself, so it works without a clone of the repo. And where in those
//! changes a new review thread can go.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use clap::Args;
use serde::Serialize;
use similar::{ChangeTag, TextDiff};

use super::pr::find_pull_request;
use crate::ado::client::AdoClient;
use crate::ado::types::{Anchor, Change, PullRequest};
use crate::app::App;
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::par;
use crate::text::{decode, Style};

#[derive(Args)]
pub struct Diff {
    /// PR id or link (default: the current branch's)
    pub pr: Option<String>,
    /// Only which files changed, not what changed in them
    #[arg(long, conflicts_with = "files")]
    pub names: bool,
    /// Only these files, and in JSON, each one's whole text before and after
    #[arg(long, value_name = "PATHS", num_args = 1..)]
    pub files: Vec<String>,
    /// How many unchanged lines to show around each change
    #[arg(long, value_name = "LINES", default_value_t = 3)]
    pub context: usize,
    /// Open the PR's changed files in the browser
    #[arg(short, long)]
    pub web: bool,
}

/// A pull request's latest push against where its branch left the target:
/// what Azure DevOps' own Files tab shows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDiff {
    pub pr_id: u64,
    /// Which push this is, counted from 1.
    pub iteration: u64,
    pub base: String,
    pub head: String,
    pub files: Vec<FileDiff>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// From the repo's root, with a leading slash, as a thread's location has it.
    /// Where the file is now, or for a deleted one, where it was.
    pub path: String,
    /// Where it was, when it was renamed.
    pub old_path: Option<String>,
    /// added | edited | deleted | renamed
    pub change: &'static str,
    /// What was changed in it, unless only names were asked for.
    #[serde(flatten)]
    pub content: Option<Content>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    /// Not text: there are no lines to show.
    pub binary: bool,
    pub added: usize,
    pub removed: usize,
    /// It changes more lines than are sent unasked: `hunks` is empty, and
    /// asking for the file by name gets them.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub large: bool,
    pub hunks: Vec<Hunk>,
    /// The whole file before and after, for a file asked for by name. None where there is no such side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<String>,
}

/// A run of changed lines with the unchanged ones around it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub lines: Vec<Line>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// context | added | removed
    pub kind: &'static str,
    /// Its 1-based number in the old file, and in the new: a line has both only when it is unchanged.
    pub old: Option<u64>,
    pub new: Option<u64>,
    /// The line without its line break, CRLF or LF.
    pub text: String,
    /// The file ends here without a line break.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_newline: bool,
}

/// How many files are read at the same time.
const AT_ONCE: usize = 8;
/// The most lines one file's hunks hold when the whole pull request is asked
/// for: a generated file with a hundred thousand new lines would otherwise
/// be most of the answer. A file asked for by name comes whole whatever its size.
const LARGE: usize = 10_000;
/// Longer than this and a file's lines are matched up roughly, not minimally.
const PATIENCE: Duration = Duration::from_secs(2);
/// Files that are never text, so their contents aren't fetched to find that out.
const BINARY: [&str; 34] = [
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
    "tar", "jar", "war", "exe", "dll", "so", "dylib", "pdb", "bin", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4",
    "mov", "nupkg",
];

/// A path as Azure DevOps writes it, from however it was typed: `src\a.ts`, `./src/a.ts`, `/src/a.ts`.
pub fn repo_path(typed: &str) -> String {
    let path = typed.trim().replace('\\', "/");
    format!("/{}", path.trim_start_matches("./").trim_start_matches('/'))
}

/// The lines of `old` and `new` that differ, each run with `context` unchanged lines around it.
pub fn hunks(old: &str, new: &str, context: usize) -> Vec<Hunk> {
    let diff = TextDiff::configure().timeout(PATIENCE).diff_lines(old, new);
    let hunk = |ops: &Vec<similar::DiffOp>| {
        let (first, last) = (ops.first()?, ops.last()?);
        let (old, new) = (first.old_range().start..last.old_range().end, first.new_range().start..last.new_range().end);
        // As git counts: an empty range starts at the line before it.
        let start = |range: &std::ops::Range<usize>| (range.start + usize::from(!range.is_empty())) as u64;
        let line = |change: similar::Change<&str>| Line {
            kind: match change.tag() {
                ChangeTag::Equal => "context",
                ChangeTag::Delete => "removed",
                ChangeTag::Insert => "added",
            },
            old: change.old_index().map(|at| at as u64 + 1),
            new: change.new_index().map(|at| at as u64 + 1),
            text: change.value().trim_end_matches('\n').trim_end_matches('\r').to_string(),
            no_newline: change.missing_newline(),
        };
        Some(Hunk {
            old_start: start(&old),
            old_lines: old.len() as u64,
            new_start: start(&new),
            new_lines: new.len() as u64,
            lines: ops.iter().flat_map(|op| diff.iter_changes(op)).map(line).collect(),
        })
    };
    diff.grouped_ops(context).iter().filter_map(hunk).collect()
}

fn named_binary(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').is_some_and(|(_, ext)| BINARY.contains(&ext.to_ascii_lowercase().as_str()))
}

/// One side of a file: its text, or that it has none.
enum Side {
    Text(String),
    Binary,
}

fn side(blob: &str, bytes: Option<&[u8]>) -> Side {
    match bytes {
        Some(bytes) => decode(bytes).map_or(Side::Binary, Side::Text),
        // A submodule: a commit of another repo, which git shows as this one line.
        None => Side::Text(format!("Subproject commit {}\n", blob.to_ascii_lowercase())),
    }
}

/// What changed inside one file. `whole` keeps both sides' full text as well.
fn content(change: &Change, blobs: &HashMap<String, Option<Vec<u8>>>, context: usize, whole: bool) -> Content {
    if named_binary(change.at()) {
        return Content { binary: true, ..Content::default() };
    }
    // A file that only moved has nothing to compare, and is read once if its text is wanted.
    let moved_only = change.blob.is_some() && change.blob == change.old_blob;
    let read = |blob: &Option<String>| blob.as_deref().map(|id| side(id, blobs[id].as_deref()));
    let (old, new) = match (moved_only, whole) {
        (true, false) => return Content::default(),
        (true, true) => (read(&change.blob), None),
        (false, _) => (read(&change.old_blob), read(&change.blob)),
    };
    // A file that is binary on either side has no lines to compare on the other.
    let text = |side: Option<Side>| match side {
        Some(Side::Text(text)) => Ok(Some(text)),
        Some(Side::Binary) => Err(Content { binary: true, ..Content::default() }),
        None => Ok(None),
    };
    let (old, new) = match (text(old), text(new)) {
        (Ok(old), Ok(_)) if moved_only => (old.clone(), old),
        (Ok(old), Ok(new)) => (old, new),
        (Err(binary), _) | (_, Err(binary)) => return binary,
    };
    let hunks = hunks(old.as_deref().unwrap_or(""), new.as_deref().unwrap_or(""), context);
    let count = |kind: &str| hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind == kind).count();
    let large = !whole && hunks.iter().map(|h| h.lines.len()).sum::<usize>() > LARGE;
    Content {
        binary: false,
        added: count("added"),
        removed: count("removed"),
        large,
        hunks: if large { Vec::new() } else { hunks },
        old: old.filter(|_| whole),
        new: new.filter(|_| whole),
    }
}

/// "X isn't changed in PR #9", with what is, for a path that was asked for.
fn not_changed(path: &str, pr: &PullRequest, changes: &[Change]) -> Error {
    const SHOWN: usize = 10;
    let mut changed: Vec<&str> = changes.iter().map(Change::at).take(SHOWN).collect();
    if changes.len() > SHOWN {
        changed.push("…");
    }
    let what = match changed.is_empty() {
        true => "It changes no files.".to_string(),
        false => format!("It changes: {}", changed.join(", ")),
    };
    Error::not_found(format!("{path} isn't changed in PR #{}. {what}", pr.id))
}

impl Diff {
    pub fn run(&self, app: &App) -> Result<Output> {
        let (pr, ado) = find_pull_request(app, self.pr.as_deref())?;
        if self.web {
            return Ok(Output::none().web(true, &format!("{}?_a=files", pr.url)));
        }
        let (iteration, mut changes) = ado.review_files(&pr)?;
        if !self.files.is_empty() {
            let wanted: Vec<String> = self.files.iter().map(|path| repo_path(path)).collect();
            let touches =
                |c: &Change, path: &String| c.path.as_ref() == Some(path) || c.old_path.as_ref() == Some(path);
            if let Some(stray) = wanted.iter().find(|path| !changes.iter().any(|c| touches(c, path))) {
                return Err(not_changed(stray, &pr, &changes));
            }
            changes.retain(|c| wanted.iter().any(|path| touches(c, path)));
        }

        let whole = !self.files.is_empty();
        let mut contents = Vec::with_capacity(changes.len());
        for group in changes.chunks(AT_ONCE) {
            if self.names {
                contents.extend(group.iter().map(|_| None));
                continue;
            }
            let ids: BTreeSet<_> = group
                .iter()
                .filter(|c| !named_binary(c.at()) && (whole || c.blob != c.old_blob))
                .flat_map(|c| [c.old_blob.as_deref(), c.blob.as_deref()])
                .flatten()
                .collect();
            let blobs = ado.review_blobs(&pr, &ids)?;
            contents.extend(par::map(group, |c| Some(content(c, &blobs, self.context, whole))));
        }
        let files: Vec<FileDiff> = changes
            .iter()
            .zip(contents)
            .map(|(change, content)| FileDiff {
                path: change.at().to_string(),
                old_path: change.old_path.clone().filter(|_| change.kind == "renamed"),
                change: change.kind,
                content,
            })
            .collect();

        let text = if files.is_empty() {
            app.style.dim(&format!("PR #{} changes no files.", pr.id))
        } else if self.names {
            names(&files)
        } else {
            files.iter().map(|file| patch(app.style, file)).collect::<Vec<_>>().join("\n")
        };
        let diff = PullRequestDiff {
            pr_id: pr.id,
            iteration: iteration.id,
            base: iteration.base,
            head: iteration.head,
            files,
        };
        Ok(Output::new(&diff, text))
    }
}

/// One file to a line: what happened to it, and where it is.
fn names(files: &[FileDiff]) -> String {
    let line = |file: &FileDiff| match &file.old_path {
        Some(old) => format!("{:<8} {old} -> {}", file.change, file.path),
        None => format!("{:<8} {}", file.change, file.path),
    };
    files.iter().map(line).collect::<Vec<_>>().join("\n")
}

/// One file as `git diff` would print it.
fn patch(s: Style, file: &FileDiff) -> String {
    let bare = |path: &str| path.trim_start_matches('/').to_string();
    let (after, before) = (bare(&file.path), bare(file.old_path.as_deref().unwrap_or(&file.path)));
    let mut out = vec![s.bold(&format!("diff --git a/{before} b/{after}"))];
    match file.change {
        "added" => out.push(s.bold("new file")),
        "deleted" => out.push(s.bold("deleted file")),
        "renamed" => out.extend([s.bold(&format!("rename from {before}")), s.bold(&format!("rename to {after}"))]),
        _ => {}
    }
    let Some(content) = &file.content else { return out.join("\n") };
    if content.binary {
        out.push("Binary files differ".to_string());
    }
    if content.large {
        out.push(s.dim(&format!(
            "Too large to show here: {} lines added, {} removed. Ask for it by name: --files {after}",
            content.added, content.removed
        )));
    }
    if !content.hunks.is_empty() {
        let side = |there: bool, mark: &str, path: &str| match there {
            true => format!("{mark}/{path}"),
            false => "/dev/null".to_string(),
        };
        out.push(s.bold(&format!("--- {}", side(file.change != "added", "a", &before))));
        out.push(s.bold(&format!("+++ {}", side(file.change != "deleted", "b", &after))));
    }
    for hunk in &content.hunks {
        let range = |start: u64, lines: u64| if lines == 1 { start.to_string() } else { format!("{start},{lines}") };
        out.push(s.dim(&format!(
            "@@ -{} +{} @@",
            range(hunk.old_start, hunk.old_lines),
            range(hunk.new_start, hunk.new_lines)
        )));
        for line in &hunk.lines {
            out.push(match line.kind {
                "added" => s.green(&format!("+{}", line.text)),
                "removed" => s.red(&format!("-{}", line.text)),
                _ => format!(" {}", line.text),
            });
            if line.no_newline {
                out.push(s.dim("\\ No newline at end of file"));
            }
        }
    }
    out.join("\n")
}

/* ---------------- where a comment goes ---------------- */

/// `path:line` or `path:first-last`.
fn parse_at(at: &str) -> Result<(String, u64, u64)> {
    let wrong = || Error::user(format!("\"{at}\" isn't a place in a file. Write it as path:line, or path:first-last."));
    let (path, lines) = at.rsplit_once(':').filter(|(path, _)| !path.trim().is_empty()).ok_or_else(wrong)?;
    let number = |text: &str| text.trim().parse::<u64>().ok().filter(|line| *line > 0);
    let (first, last) = match lines.split_once('-') {
        Some((first, last)) => (number(first), number(last)),
        None => (number(lines), number(lines)),
    };
    match (first, last) {
        (Some(first), Some(last)) if first <= last => Ok((repo_path(path), first, last)),
        _ => Err(wrong()),
    }
}

/// Where a new thread goes, checked against the pull request's latest push:
/// the file has to be one it changes, and the lines have to be in it.
pub fn anchor(ado: &AdoClient, pr: &PullRequest, at: &str, old: bool) -> Result<Anchor> {
    let (file, line, end_line) = parse_at(at)?;
    let changes = ado.review_files(pr)?.1;
    // What a renamed file was can be named by either of its paths.
    let on = |c: &&Change| match old {
        true => c.old_path.is_some() && (c.old_path.as_ref() == Some(&file) || c.path.as_ref() == Some(&file)),
        false => c.path.as_ref() == Some(&file),
    };
    let Some(change) = changes.iter().find(on) else {
        // It may be there, just not on the side that was asked for.
        return Err(
            match changes.iter().find(|c| c.path.as_ref() == Some(&file) || c.old_path.as_ref() == Some(&file)) {
                Some(c) if c.kind == "added" => {
                    Error::user(format!("{file} is new in PR #{}: it has no old side.", pr.id))
                }
                Some(c) if c.kind == "deleted" => {
                    Error::user(format!("{file} is deleted in PR #{}: comment on what it was with --old.", pr.id))
                }
                Some(c) => Error::user(format!(
                    "{file} is renamed in PR #{}: it is {} now, and was {}.",
                    pr.id,
                    c.path.as_deref().unwrap_or("?"),
                    c.old_path.as_deref().unwrap_or("?")
                )),
                None => not_changed(&file, pr, &changes),
            },
        );
    };
    let not_text = || Error::user(format!("{file} isn't text: it has no lines to comment on."));
    let blob = if old { &change.old_blob } else { &change.blob };
    let id = blob.as_deref().filter(|_| !named_binary(&file)).ok_or_else(not_text)?;
    let text = match side(id, ado.blob(pr, id)?.as_deref()) {
        Side::Text(text) => text,
        _ => return Err(not_text()),
    };
    let lines: Vec<&str> = text.lines().collect();
    let Some(last) = lines.get(end_line as usize - 1) else {
        let side = if old { " before this pull request" } else { "" };
        let count = match lines.len() {
            1 => "1 line".to_string(),
            n => format!("{n} lines"),
        };
        return Err(Error::user(format!("{file} has {count}{side}; there is no line {end_line}.")));
    };
    // Azure DevOps knows a renamed file by its new path, on both sides: a thread under the old one is on no file.
    Ok(Anchor { file: change.at().to_string(), line, end_line, end_width: last.encode_utf16().count() as u64, old })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::testing::{bytes_response, cli, json_response, ok, rest_pr, Bed, Recorded, Route};

    fn blobs(r: &Recorded, content: impl Fn(&str) -> Option<Vec<u8>>) -> Option<crate::ado::Response> {
        use std::io::{Cursor, Write};
        if let Some((_, id)) = r.path.split_once("/blobs/") {
            return Some(match content(id) {
                Some(bytes) => bytes_response(&bytes),
                None => json_response(400, json!({"message":"TF401035: object does not exist"})),
            });
        }
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for id in r.body.as_array().unwrap().iter().map(|id| id.as_str().unwrap()) {
            if let Some(bytes) = content(id) {
                zip.start_file(id, zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(&bytes).unwrap();
            }
        }
        Some(bytes_response(&zip.finish().unwrap().into_inner()))
    }

    /// PR 9, pushed to twice. Its second push edits a file, adds one, renames one untouched, deletes one and adds a picture.
    fn changed() -> Route {
        Box::new(|r: &Recorded| {
            if r.path.contains("/HierarchyQuery/") {
                let entry = |kind: &str, item: Value, was: Value| json!({ "changeType": kind, "item": item, "originalPath": was });
                crate::testing::review_page(
                    2,
                    "second",
                    json!([
                        entry(
                            "edit",
                            json!({ "path": "/src/numbers.txt", "objectId": "new-numbers", "originalObjectId": "old-numbers" }),
                            json!(null)
                        ),
                        entry("add", json!({ "path": "/src/new.ts", "objectId": "new-ts" }), json!(null)),
                        entry(
                            "rename",
                            json!({ "path": "/docs/to.md", "objectId": "same", "originalObjectId": "same" }),
                            json!("/docs/from.md")
                        ),
                        entry(
                            "delete",
                            json!({ "path": null, "originalObjectId": "doomed" }),
                            json!("/docs/doomed.md")
                        ),
                        entry("add", json!({ "path": "/shot.png", "objectId": "picture" }), json!(null)),
                        entry("add", json!({ "path": "/src", "isFolder": true }), json!(null)),
                    ]),
                    json!([]),
                )
            } else if r.path.contains("/blobs") {
                blobs(r, |id| {
                    Some(
                        match id {
                            "old-numbers" => "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
                            "new-numbers" => "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine",
                            "new-ts" => "export const shiny = true;\n",
                            "same" => "as it was\n",
                            "doomed" => "going away\n",
                            _ => return None,
                        }
                        .as_bytes()
                        .to_vec(),
                    )
                })
            } else if r.method == "POST" {
                let said = json!([{ "id": 1, "content": "x" }]);
                ok(json!({ "id": 31, "status": "active", "threadContext": r.body["threadContext"], "comments": said }))
            } else {
                ok(rest_pr(9, json!({})))
            }
        })
    }

    #[test]
    fn finds_the_lines_that_differ_and_numbers_them_on_both_sides() {
        let found = hunks("a\nb\nc\nd\ne\nf\n", "a\nB\nc\nd\ne\nf\ng", 1);
        let line = |kind: &'static str, old: Option<u64>, new: Option<u64>, text: &str| Line {
            kind,
            old,
            new,
            text: text.to_string(),
            no_newline: false,
        };
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!((found[0].old_start, found[0].old_lines, found[0].new_start, found[0].new_lines), (1, 3, 1, 3));
        assert_eq!(
            found[0].lines,
            [
                line("context", Some(1), Some(1), "a"),
                line("removed", Some(2), None, "b"),
                line("added", None, Some(2), "B"),
                line("context", Some(3), Some(3), "c"),
            ]
        );
        assert_eq!((found[1].old_start, found[1].old_lines, found[1].new_start, found[1].new_lines), (6, 1, 6, 2));
        assert_eq!(found[1].lines.last(), Some(&Line { no_newline: true, ..line("added", None, Some(7), "g") }));

        // A file that is all new starts, as git has it, at nothing.
        let new = hunks("", "x\ny\n", 3);
        assert_eq!((new[0].old_start, new[0].old_lines, new[0].new_start, new[0].new_lines), (0, 0, 1, 2));
        assert!(hunks("same\n", "same\n", 3).is_empty());
    }

    #[test]
    fn diffs_a_pull_requests_latest_push_file_by_file_without_a_clone() {
        let bed = Bed::new(changed());
        let diff = cli(bed.app(), &["pr", "diff", "9", "--json"]).json();
        assert_eq!(
            (&diff["prId"], &diff["iteration"], &diff["base"], &diff["head"]),
            (&json!(9), &json!(2), &json!("base"), &json!("second"))
        );
        let file = |at: usize| &diff["files"][at];
        let seen: Vec<_> =
            (0..5).map(|at| (file(at)["path"].as_str().unwrap(), file(at)["change"].as_str().unwrap())).collect();
        // A folder is not a file, and isn't listed.
        assert_eq!(diff["files"].as_array().unwrap().len(), 5);
        assert_eq!(
            seen,
            [
                ("/src/numbers.txt", "edited"),
                ("/src/new.ts", "added"),
                ("/docs/to.md", "renamed"),
                ("/docs/doomed.md", "deleted"),
                ("/shot.png", "added")
            ]
        );

        assert_eq!((&file(0)["added"], &file(0)["removed"], &file(0)["binary"]), (&json!(2), &json!(1), &json!(false)));
        assert_eq!(file(0)["hunks"][0]["lines"][1], json!({ "kind": "removed", "old": 2, "new": null, "text": "two" }));
        assert_eq!(file(0)["hunks"][0]["lines"][2], json!({ "kind": "added", "old": null, "new": 2, "text": "TWO" }));
        // Whole files are only sent when a file is asked for by name.
        assert!(file(0).get("old").is_none() && file(0).get("new").is_none());

        assert_eq!((&file(2)["oldPath"], &file(2)["hunks"]), (&json!("/docs/from.md"), &json!([])));
        assert_eq!((&file(3)["oldPath"], &file(3)["removed"]), (&json!(null), &json!(1)));
        assert_eq!((&file(4)["binary"], &file(4)["hunks"]), (&json!(true), &json!([])));

        // What only moved is not read, and a picture is not read to learn it is one.
        let archives: Vec<_> = bed.ado.requests().into_iter().filter(|r| r.path.ends_with("/blobs")).collect();
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].body, json!(["doomed", "new-numbers", "new-ts", "old-numbers"]));
    }

    #[test]
    fn prints_it_as_git_would() {
        let bed = Bed::new(changed());
        let screen = cli(bed.app(), &["pr", "diff", "9", "--context", "1"]).stdout;
        let edit = "diff --git a/src/numbers.txt b/src/numbers.txt\n--- a/src/numbers.txt\n+++ b/src/numbers.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -8 +8,2 @@\n eight\n+nine\n\\ No newline at end of file\n";
        assert!(screen.starts_with(edit), "{screen}");
        assert!(screen.contains("diff --git a/src/new.ts b/src/new.ts\nnew file\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const shiny = true;\n"), "{screen}");
        assert!(
            screen.contains(
                "diff --git a/docs/from.md b/docs/to.md\nrename from docs/from.md\nrename to docs/to.md\ndiff"
            ),
            "{screen}"
        );
        assert!(
            screen.contains("deleted file\n--- a/docs/doomed.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-going away\n"),
            "{screen}"
        );
        assert!(screen.ends_with("diff --git a/shot.png b/shot.png\nnew file\nBinary files differ\n"), "{screen}");
    }

    #[test]
    fn names_alone_cost_no_file_and_one_file_comes_whole() {
        let bed = Bed::new(changed());
        let res = cli(bed.app(), &["pr", "diff", "9", "--names"]);
        assert!(res.stdout.starts_with("edited   /src/numbers.txt\nadded    /src/new.ts\nrenamed  /docs/from.md -> /docs/to.md\ndeleted  /docs/doomed.md\n"), "{}", res.stdout);
        assert!(bed.ado.requests().iter().all(|r| !r.path.contains("/blobs")));
        let named = cli(bed.app(), &["pr", "diff", "9", "--names", "--json"]).json();
        assert_eq!(named["files"][0], json!({ "path": "/src/numbers.txt", "oldPath": null, "change": "edited" }));

        // However the path is typed; and a file that only moved is still read, once, for its text.
        let bed = Bed::new(changed());
        let one = cli(bed.app(), &["pr", "diff", "9", "--json", "--files", "src\\new.ts", "docs/from.md"]).json();
        let file = |at: usize| &one["files"][at];
        assert_eq!(one["files"].as_array().unwrap().len(), 2);
        assert_eq!(
            (&file(0)["path"], &file(0)["old"], &file(0)["new"]),
            (&json!("/src/new.ts"), &json!(null), &json!("export const shiny = true;\n"))
        );
        assert!(file(0).get("old").is_none());
        assert_eq!(
            (&file(1)["old"], &file(1)["new"], &file(1)["hunks"]),
            (&json!("as it was\n"), &json!("as it was\n"), &json!([]))
        );
        assert!(bed.ado.requests().iter().any(|r| r.path.ends_with("/blobs") && r.body == json!(["new-ts", "same"])));

        let res = cli(bed.app(), &["pr", "diff", "9", "--files", "README.md"]);
        assert_eq!(res.code, 2);
        assert!(
            res.stderr.contains("/README.md isn't changed in PR #9. It changes: /src/numbers.txt, /src/new.ts,"),
            "{}",
            res.stderr
        );
    }

    /// PR 9 again, with the files that aren't plain UTF-8 with Unix line endings.
    fn awkward() -> Route {
        Box::new(|r: &Recorded| {
            let utf16 = |text: &str| text.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
            let many = (0..10_001).map(|n| format!("pinned {n}\n")).collect::<String>();
            if r.path.contains("/HierarchyQuery/") {
                let edit = |path: &str| json!({ "changeType": "edit", "item": { "path": path, "objectId": format!("new{path}"), "originalObjectId": format!("old{path}") } });
                crate::testing::review_page(
                    1,
                    "head",
                    json!([
                        edit("/wide.txt"),
                        edit("/latin.txt"),
                        edit("/dos.txt"),
                        edit("/data"),
                        edit("/vendor/lib"),
                        edit("/generated.lock")
                    ]),
                    json!([]),
                )
            } else if r.path.contains("/blobs") {
                blobs(r, |id| {
                    Some(match id {
                        "old/wide.txt" => utf16("\u{feff}alpha\r\nbeta\r\n"),
                        "new/wide.txt" => utf16("\u{feff}alpha\r\nBETA \u{1F642}\r\n"),
                        "old/latin.txt" => b"caf\xE9\n".to_vec(),
                        "new/latin.txt" => b"caf\xE9s\n".to_vec(),
                        "old/dos.txt" => b"one\r\ntwo\r\n".to_vec(),
                        "new/dos.txt" => b"one\ntwo\n".to_vec(),
                        "old/data" => b"plain once\n".to_vec(),
                        "new/data" => b"\x89PNG\x00\x00".to_vec(),
                        "old/generated.lock" => many.as_bytes().to_vec(),
                        "new/generated.lock" => Vec::new(),
                        _ => return None,
                    })
                })
            } else if r.method == "POST" {
                ok(
                    json!({ "id": 31, "status": "active", "threadContext": r.body["threadContext"], "comments": [{ "id": 1, "content": "x" }] }),
                )
            } else {
                ok(rest_pr(9, json!({})))
            }
        })
    }

    #[test]
    fn reads_files_in_other_encodings_and_shows_what_is_not_a_text_file_for_what_it_is() {
        let bed = Bed::new(awkward());
        let diff = cli(bed.app(), &["pr", "diff", "9", "--json"]).json();
        let file = |at: usize| &diff["files"][at];
        let changed = |at: usize| {
            let lines = file(at)["hunks"][0]["lines"].as_array().unwrap().clone();
            lines
                .into_iter()
                .filter(|l| l["kind"] != "context")
                .map(|l| format!("{} {}", l["kind"].as_str().unwrap(), l["text"].as_str().unwrap()))
                .collect::<Vec<_>>()
        };
        // UTF-16 and Windows-1252 are text; a line's text is without its line break, CRLF or LF.
        assert_eq!(changed(0), ["removed beta", "added BETA \u{1F642}"]);
        assert_eq!(changed(1), ["removed caf\u{e9}", "added caf\u{e9}s"]);
        // Line endings alone are a change, of every line.
        assert_eq!(changed(2), ["removed one", "removed two", "added one", "added two"]);
        // Binary on one side is binary.
        assert_eq!((&file(3)["binary"], &file(3)["hunks"]), (&json!(true), &json!([])));
        // A submodule reads as git shows it, and doesn't stop the rest.
        assert_eq!(changed(4), ["removed Subproject commit old/vendor/lib", "added Subproject commit new/vendor/lib"]);
        // A file that changes more lines than anyone asked to see is counted, not sent.
        assert_eq!(
            (&file(5)["large"], &file(5)["added"], &file(5)["removed"], &file(5)["hunks"]),
            (&json!(true), &json!(0), &json!(10_001), &json!([]))
        );
        assert!(file(0).get("large").is_none());
        let screen = cli(bed.app(), &["pr", "diff", "9"]).stdout;
        assert!(
            screen.ends_with(
                "Too large to show here: 0 lines added, 10001 removed. Ask for it by name: --files generated.lock\n"
            ),
            "{}",
            &screen[screen.len() - 200..]
        );

        // Asked for by name, it comes whole; and the text is without the byte-order mark.
        let named = cli(bed.app(), &["pr", "diff", "9", "--json", "--files", "generated.lock", "wide.txt"]).json();
        assert_eq!(named["files"][0]["old"], json!("alpha\r\nbeta\r\n"));
        assert_eq!(
            (named["files"][1].get("large"), named["files"][1]["hunks"][0]["lines"].as_array().unwrap().len()),
            (None, 10_001)
        );

        // A comment's end is counted the way Azure DevOps counts a line: in UTF-16 units, without the line break.
        let bed = Bed::new(awkward());
        assert_eq!(cli(bed.app(), &["pr", "comment", "9", "x", "--at", "wide.txt:2"]).code, 0);
        let posted =
            bed.ado.requests().into_iter().find(|r| r.method == "POST" && r.path.ends_with("/threads")).unwrap();
        assert_eq!(posted.body["threadContext"]["rightFileEnd"], json!({ "line": 2, "offset": 8 }));
        let res = cli(bed.app(), &["pr", "comment", "9", "x", "--at", "data:1"]);
        assert!(res.code == 1 && res.stderr.contains("/data isn't text"), "{}", res.stderr);
    }

    #[test]
    fn a_comment_goes_on_whole_lines_of_either_side_of_a_changed_file() {
        let posted = |bed: &Bed| {
            bed.ado
                .requests()
                .into_iter()
                .find(|r| r.method == "POST" && r.path.ends_with("/threads"))
                .map(|r| r.body["threadContext"].clone())
        };

        let bed = Bed::new(changed());
        let res = cli(bed.app(), &["pr", "comment", "9", "Why?", "--at", "src/numbers.txt:2-3"]);
        assert_eq!(
            (res.code, res.stdout.as_str()),
            (0, "Posted thread #31 on PR #9, at /src/numbers.txt:2-3.\n"),
            "{}",
            res.stderr
        );
        // From the start of the first line to just past the end of the last.
        let whole_lines = json!({ "filePath": "/src/numbers.txt", "rightFileStart": { "line": 2, "offset": 1 }, "rightFileEnd": { "line": 3, "offset": 6 } });
        assert_eq!(posted(&bed), Some(whole_lines));

        let bed = Bed::new(changed());
        assert_eq!(cli(bed.app(), &["pr", "comment", "9", "Sad", "--at", "/docs/doomed.md:1", "--old"]).code, 0);
        let was = json!({ "filePath": "/docs/doomed.md", "leftFileStart": { "line": 1, "offset": 1 }, "leftFileEnd": { "line": 1, "offset": 11 } });
        assert_eq!(posted(&bed), Some(was));

        // What a renamed file was is commented on under its new path, whichever it is asked for by.
        for typed in ["docs/from.md:1", "docs/to.md:1"] {
            let bed = Bed::new(changed());
            assert_eq!(cli(bed.app(), &["pr", "comment", "9", "Moved", "--at", typed, "--old"]).code, 0);
            let renamed = json!({ "filePath": "/docs/to.md", "leftFileStart": { "line": 1, "offset": 1 }, "leftFileEnd": { "line": 1, "offset": 10 } });
            assert_eq!(posted(&bed), Some(renamed));
        }

        // Nothing is posted to a place that isn't there.
        let refused = |args: &[&str], why: &str| {
            let bed = Bed::new(changed());
            let res = cli(bed.app(), &[&["pr", "comment", "9", "x"], args].concat());
            assert_eq!(res.code, if why.contains("isn't changed") { 2 } else { 1 }, "{args:?}");
            assert!(res.stderr.contains(why), "{args:?}: {}", res.stderr);
            assert!(posted(&bed).is_none(), "{args:?}");
        };
        refused(&["--at", "src/numbers.txt:10"], "/src/numbers.txt has 9 lines; there is no line 10.");
        refused(
            &["--at", "src/numbers.txt:9", "--old"],
            "/src/numbers.txt has 8 lines before this pull request; there is no line 9.",
        );
        refused(&["--at", "src/new.ts:1", "--old"], "/src/new.ts is new in PR #9: it has no old side.");
        refused(
            &["--at", "docs/doomed.md:1"],
            "/docs/doomed.md is deleted in PR #9: comment on what it was with --old.",
        );
        refused(
            &["--at", "docs/from.md:1"],
            "/docs/from.md is renamed in PR #9: it is /docs/to.md now, and was /docs/from.md.",
        );
        refused(&["--at", "README.md:1"], "/README.md isn't changed in PR #9.");
        refused(&["--at", "shot.png:1"], "/shot.png isn't text");
        refused(&["--at", "src/numbers.txt"], "isn't a place in a file");
        refused(&["--at", "src/numbers.txt:3-2"], "isn't a place in a file");
        refused(&["--old"], "--at");
    }
}
