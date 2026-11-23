//! Pictures in pull request text. Write a markdown image that points at a
//! file on disk — `![the new screen](shot.png)` — and dova uploads the file
//! to the pull request and points the image at the upload.
//!
//! And the other way: a picture's link in text read from Azure DevOps only
//! loads for someone signed in, so on request each link is replaced by the
//! picture itself, as a `data:` URL, which loads anywhere.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::path::Path;

use serde_json::Value;

use crate::ado::client::AdoClient;
use crate::ado::types::PullRequest;
use crate::app::App;
use crate::error::{Error, Result};

/// Text with the local images it shows already read, so a missing file is
/// found before anything is posted.
pub struct Illustrated {
    text: String,
    /// Where each path sits in the text, the name it is uploaded under, and the file.
    images: Vec<(Range<usize>, String, Vec<u8>)>,
}

impl Illustrated {
    /// Paths are relative to `cwd`.
    pub fn read(text: String, cwd: &Path) -> Result<Illustrated> {
        let mut images = Vec::new();
        for span in local_images(&text) {
            let path = &text[span.clone()];
            let bytes = std::fs::read(cwd.join(path))
                .map_err(|err| Error::user(format!("Could not read the image \"{path}\": {err}")))?;
            images.push((span, upload_name(path, &bytes), bytes));
        }
        Ok(Illustrated { text, images })
    }

    pub fn has_images(&self) -> bool {
        !self.images.is_empty()
    }

    /// The text as written, local paths and all.
    pub fn as_written(&self) -> &str {
        &self.text
    }

    /// Uploads each image to the pull request; the text with every path replaced by its upload.
    pub fn upload(self, ado: &AdoClient, pr: &PullRequest) -> Result<String> {
        let mut text = self.text;
        // Last first, so the earlier spans still point at the right place.
        for (span, name, bytes) in self.images.into_iter().rev() {
            text.replace_range(span, &ado.attach(pr, &name, &bytes)?);
        }
        Ok(text)
    }
}

/// Where the path of each `![alt](path)` sits, for the paths that aren't
/// already addresses. Code — fenced or in backticks — is left alone.
fn local_images(markdown: &str) -> Vec<Range<usize>> {
    markdown_images(markdown, |path| {
        !["http://", "https://", "data:", "//"].iter().any(|scheme| path.starts_with(scheme))
    })
}

/// Where the target of each `![alt](target)` that `wanted` picks sits. Code — fenced or in backticks — is left alone.
fn markdown_images(markdown: &str, wanted: impl Fn(&str) -> bool) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    let (mut fenced, mut start) = (false, 0);
    for line in markdown.split_inclusive('\n') {
        let fence = line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~");
        fenced ^= fence;
        if !fenced && !fence {
            let targets = images_in_line(line).into_iter().filter(|span| wanted(&line[span.clone()]));
            found.extend(targets.map(|span| start + span.start..start + span.end));
        }
        start += line.len();
    }
    found
}

/* ---------------- reading: a link that loads without signing in ---------------- */

/// The most a picture may weigh to take its link's place: past this, the link stays.
const HEAVIEST: usize = 8 * 1024 * 1024;
/// How many pictures are fetched at the same time.
const AT_ONCE: usize = 8;

/// Whether an address is on Azure DevOps, where dova's sign-in is what loads it.
/// Anything else loads without dova, or is not dova's to ask for.
fn on_azure_devops(address: &str) -> bool {
    let Ok(url) = url::Url::parse(address) else { return false };
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https" && (host == "dev.azure.com" || host.ends_with(".visualstudio.com"))
}

/// Where the address of each picture on Azure DevOps sits in text a person
/// wrote: markdown's `![alt](address)` and HTML's `<img src="address">`.
fn pictures(text: &str) -> Vec<Range<usize>> {
    let mut found = markdown_images(text, on_azure_devops);
    let mut from = 0;
    while let Some(tag) = text[from..].find("<img").map(|at| from + at) {
        let end = text[tag..].find('>').map_or(text.len(), |at| tag + at);
        let src = crate::text::attribute(&text[tag + 1..end], "src").filter(|src| on_azure_devops(src));
        // The value is a slice of the text: where it starts in it is where it is.
        found.extend(src.map(|src| {
            let start = src.as_ptr() as usize - text.as_ptr() as usize;
            start..start + src.len()
        }));
        from = end;
    }
    found.sort_by_key(|span| span.start);
    found.dedup();
    found
}

/// What a file is, from how it starts: Azure DevOps hands a work item's picture over as "some bytes".
fn kind(start: &[u8], said: Option<&str>) -> Option<String> {
    let known = match start {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        [b'B', b'M', ..] => Some("image/bmp"),
        _ => None,
    };
    let said = said.map(|said| said.split(';').next().unwrap_or("").trim()).filter(|said| said.starts_with("image/"));
    known.or(said).map(str::to_string)
}

/// A picture as a `data:` URL. None for anything that isn't one, is too heavy, or can't be had:
/// its link then stays as it was, which is no worse than before.
fn data_url(ado: &AdoClient, address: &str) -> Option<String> {
    use base64::Engine;
    let (said, base64) = ado.fetch(address).ok()?;
    if base64.len() / 4 * 3 > HEAVIEST {
        return None;
    }
    let start = base64::engine::general_purpose::STANDARD.decode(base64.get(..16).unwrap_or(&base64)).ok()?;
    Some(format!("data:{};base64,{base64}", kind(&start, said.as_deref())?))
}

fn each_text<'a>(data: &'a mut Value, texts: &mut Vec<&'a mut String>) {
    match data {
        Value::String(text) => texts.push(text),
        Value::Array(items) => items.iter_mut().for_each(|item| each_text(item, texts)),
        Value::Object(fields) => fields.values_mut().for_each(|field| each_text(field, texts)),
        _ => {}
    }
}

/// Every picture on Azure DevOps that a command's result shows, put where
/// its link is. Each is fetched once however often it is shown.
pub fn inline(app: &App, data: &mut Value) {
    let mut texts = Vec::new();
    each_text(data, &mut texts);
    let shown: Vec<(usize, Range<usize>)> = texts
        .iter()
        .enumerate()
        .flat_map(|(at, text)| pictures(text).into_iter().map(move |span| (at, span)))
        .collect();
    let mut addresses: Vec<String> = shown.iter().map(|(at, span)| texts[*at][span.clone()].to_string()).collect();
    addresses.sort();
    addresses.dedup();
    if addresses.is_empty() {
        return;
    }
    // Each address is whole, so the client needs no organization of its own.
    let ado = app.ado("");
    let fetched: Vec<Option<String>> =
        addresses.chunks(AT_ONCE).flat_map(|some| crate::par::map(some, |address| data_url(&ado, address))).collect();
    // Last first, so the earlier spans of a text still point at the right place.
    for (at, span) in shown.into_iter().rev() {
        let found = addresses.binary_search(&texts[at][span.clone()].to_string()).ok();
        if let Some(picture) = found.and_then(|found| fetched[found].as_ref()) {
            texts[at].replace_range(span, picture);
        }
    }
}

fn images_in_line(line: &str) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(bang) = line[from..].find("![").map(|at| from + at) {
        from = bang + 2;
        let in_code = line[..bang].matches('`').count() % 2 == 1;
        let Some(open) = line[from..].find("](").map(|at| from + at + 2) else { break };
        let Some(close) = line[open..].find(')').map(|at| open + at) else { break };
        from = close;
        // `<a path with spaces>`, or a path up to the space before its "title".
        let target = &line[open..close];
        let path = match target.strip_prefix('<') {
            Some(rest) => rest.find('>').map(|end| open + 1..open + 1 + end),
            None => Some(open..open + target.find(char::is_whitespace).unwrap_or(target.len())),
        };
        let Some(path) = path.filter(|path| !path.is_empty()) else { continue };
        if !in_code {
            found.push(path);
        }
    }
    found
}

/// The file's own name with a mark of its contents: a pull request holds
/// each attachment name once, and the same picture twice is one upload.
fn upload_name(path: &str, bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let mark = format!("{:08x}", hasher.finish() as u32);
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let clean: String =
        file.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '-' }).collect();
    match clean.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem}-{mark}.{extension}"),
        _ => format!("{clean}-{mark}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(markdown: &str) -> Vec<&str> {
        local_images(markdown).into_iter().map(|span| &markdown[span]).collect()
    }

    #[test]
    fn finds_images_that_point_at_files_and_leaves_addresses_and_code_alone() {
        let text = "Before ![one](a.png) and ![two](<my shots/b c.png> \"A title\")\n\
                    ![web](https://example.com/x.png) ![d](data:image/png;base64,AA) `![code](c.png)`\n\
                    ```\n![fenced](d.png)\n```\n![last](C:\\shots\\e.png \"t\") [a link](f.png)\n";
        assert_eq!(paths(text), ["a.png", "my shots/b c.png", "C:\\shots\\e.png"]);
        assert_eq!(paths("no images, just ![ and ]( apart"), Vec::<&str>::new());
    }

    #[test]
    fn finds_the_pictures_that_only_load_signed_in_however_they_are_written() {
        let shot = "https://dev.azure.com/contoso/p/_apis/git/repositories/r/pullRequests/9/attachments/shot.png";
        let old = "https://contoso.visualstudio.com/_apis/wit/attachments/1b?fileName=a.png";
        let text = format!(
            "![one]({shot}) and <img alt=\"two\" src=\"{old}\" width=3> and <img src='{shot}'/>\n\
             ![elsewhere](https://example.com/x.png) <img src=\"https://example.com/y.png\"> ![local](a.png)\n\
             `![code]({shot})` ![not https](http://dev.azure.com/contoso/x.png) [a link]({shot})\n"
        );
        let found: Vec<&str> = pictures(&text).into_iter().map(|span| &text[span]).collect();
        assert_eq!(found, [shot, old, shot]);
        assert!(!on_azure_devops("https://dev.azure.com.evil.example/x.png"));
    }

    #[test]
    fn tells_what_a_picture_is_from_how_it_starts_or_else_from_what_it_is_said_to_be() {
        assert_eq!(kind(b"\x89PNG\r\n\x1a\n....", Some("application/octet-stream")).as_deref(), Some("image/png"));
        assert_eq!(kind(b"\xFF\xD8\xFF\xE0", None).as_deref(), Some("image/jpeg"));
        assert_eq!(kind(b"GIF89a", None).as_deref(), Some("image/gif"));
        assert_eq!(kind(b"RIFF\x10\x00\x00\x00WEBPVP8 ", None).as_deref(), Some("image/webp"));
        assert_eq!(kind(b"<svg xmlns=", Some("image/svg+xml; charset=utf-8")).as_deref(), Some("image/svg+xml"));
        // A sign-in page, or anything else that isn't a picture, is not shown as one.
        assert_eq!(kind(b"<!DOCTYPE html>", Some("text/html")), None);
        assert_eq!(kind(b"hello", Some("application/octet-stream")), None);
    }

    #[test]
    fn on_request_a_picture_takes_its_links_place_and_everything_else_stays() {
        use serde_json::json;

        use crate::testing::{bytes_response, cli, ok, rest_pr, Bed, Recorded, Route};

        let at = |name: &str| {
            format!(
                "https://dev.azure.com/contoso/MyProject/_apis/git/repositories/web/pullRequests/9/attachments/{name}"
            )
        };
        let description = format!(
            "![shot]({}) twice ![again]({}) then ![gone]({}) ![notes]({}) ![elsewhere](https://example.com/x.png)",
            at("shot.png"),
            at("shot.png"),
            at("gone.png"),
            at("notes.txt")
        );
        let route = |description: String| -> Route {
            Box::new(move |r: &Recorded| {
                if r.path.ends_with("/attachments/shot.png") {
                    Some(bytes_response(b"\x89PNG\r\n\x1a\nthe picture"))
                } else if r.path.ends_with("/attachments/notes.txt") {
                    Some(bytes_response(b"not a picture"))
                } else if r.path.contains("/attachments/") {
                    None
                } else if r.path.contains("/HierarchyQuery/") {
                    crate::testing::review_page(1, "head", json!([]), json!([]))
                } else if r.path.ends_with("/workitems") {
                    ok(json!({ "value": [] }))
                } else {
                    ok(rest_pr(9, json!({ "description": description })))
                }
            })
        };

        let bed = Bed::new(route(description.clone()));
        let shown = cli(bed.app(), &["pr", "view", "9", "--inline-images", "--jq", ".description"]).stdout;
        let picture = "data:image/png;base64,iVBORw0KGgp0aGUgcGljdHVyZQ==";
        // What can't be had, and what isn't a picture, keep their links: no worse than without the flag.
        let expected = format!(
            "![shot]({picture}) twice ![again]({picture}) then ![gone]({}) ![notes]({}) ![elsewhere](https://example.com/x.png)\n",
            at("gone.png"),
            at("notes.txt")
        );
        assert_eq!(shown, expected);
        let fetched: Vec<Recorded> =
            bed.ado.requests().into_iter().filter(|r| r.path.contains("/attachments/")).collect();
        // Each once, as bytes, and nothing that isn't on Azure DevOps.
        assert_eq!(fetched.len(), 3, "{:?}", fetched.iter().map(|r| &r.path).collect::<Vec<_>>());
        assert!(fetched.iter().all(|r| r.raw.binary));

        // Unasked, nothing is fetched and nothing changes.
        let bed = Bed::new(route(description.clone()));
        assert_eq!(cli(bed.app(), &["pr", "view", "9", "--jq", ".description"]).stdout, description.clone() + "\n");
        assert!(bed.ado.requests().iter().all(|r| !r.path.contains("/attachments/")));
    }

    #[test]
    fn names_an_upload_after_the_file_and_what_is_in_it() {
        let name = upload_name("shots/My Screen (1).png", b"abc");
        assert!(name.starts_with("My-Screen--1--") && name.ends_with(".png"), "{name}");
        assert_eq!(name, upload_name("elsewhere\\My Screen (1).png", b"abc"));
        assert_ne!(name, upload_name("shots/My Screen (1).png", b"abd"));
    }

    #[test]
    fn a_missing_image_is_an_error_before_anything_is_sent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("here.png"), b"png").unwrap();
        let read = |text: &str| Illustrated::read(text.to_string(), dir.path());
        assert!(read("![a](here.png)").unwrap().has_images());
        assert!(!read("no pictures").unwrap().has_images());
        let err = read("![a](gone.png)").err().unwrap();
        assert!(err.message.starts_with("Could not read the image \"gone.png\""), "{}", err.message);
    }
}
