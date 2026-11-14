//! Pictures in pull request text. Write a markdown image that points at a
//! file on disk — `![the new screen](shot.png)` — and dova uploads the file
//! to the pull request and points the image at the upload.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::path::Path;

use crate::ado::client::AdoClient;
use crate::ado::types::PullRequest;
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
    let mut found = Vec::new();
    let (mut fenced, mut start) = (false, 0);
    for line in markdown.split_inclusive('\n') {
        let fence = line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~");
        fenced ^= fence;
        if !fenced && !fence {
            found.extend(images_in_line(line).into_iter().map(|span| start + span.start..start + span.end));
        }
        start += line.len();
    }
    found
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
        let is_address =
            ["http://", "https://", "data:", "//"].iter().any(|scheme| line[path.clone()].starts_with(scheme));
        if !in_code && !is_address {
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
