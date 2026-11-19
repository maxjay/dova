//! Text for a terminal: HTML stripped, long text cut, colors and tables.

use std::time::{SystemTime, UNIX_EPOCH};

/// Rich-text work item fields are HTML. This is a tag stripper for terminal
/// display: it covers the markup and entities that actually show up, not
/// HTML in general.
pub fn strip_html(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        let Some(len) = rest[open..].find('>').filter(|len| *len > 1) else {
            // A bare `<`, not a tag.
            text.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            continue;
        };
        text.push_str(&rest[..open]);
        let written = rest[open + 1..open + len].trim_end_matches('/').trim();
        let tag = written.to_ascii_lowercase();
        let name = tag.split_whitespace().next().unwrap_or("");
        match name {
            "br" | "/p" | "/div" | "/li" => text.push('\n'),
            "li" => text.push_str("- "),
            // A picture can't be shown here, but that there is one, and where, can: as markdown has it.
            "img" => {
                if let Some(src) = attribute(written, "src").filter(|src| !src.is_empty()) {
                    text.push_str(&format!("![{}]({src})", attribute(written, "alt").unwrap_or("")));
                }
            }
            _ => {}
        }
        rest = &rest[open + len + 1..];
    }
    text.push_str(rest);

    let text = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    let mut out = String::with_capacity(text.len());
    let mut newlines = 0;
    for c in text.trim().chars() {
        newlines = if c == '\n' { newlines + 1 } else { 0 };
        if newlines <= 2 {
            out.push(c);
        }
    }
    out
}

/// The value of one attribute of an HTML tag, given without its angle
/// brackets: quoted either way, or bare. Entities are left as written.
pub fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    loop {
        let at = from + lower[from..].find(&format!("{name}="))?;
        from = at + name.len() + 1;
        // `data-src=` is not `src=`.
        if !lower[..at].ends_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let value = &tag[from..];
        return Some(match value.chars().next() {
            Some(quote @ ('"' | '\'')) => &value[1..1 + value[1..].find(quote).unwrap_or(value.len() - 1)],
            _ => &value[..value.find(char::is_whitespace).unwrap_or(value.len())],
        });
    }
}

/// The other way: plain text as the HTML a rich-text field shows exactly as typed.
/// Sent as it is, `Vec<String>` would vanish as a tag and every line break would collapse.
pub fn to_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace("\r\n", "\n").replace('\n', "<br>")
}

/// Cuts text at `max` characters, saying whether it did so callers can offer `--full`.
/// What Windows-1252 has where Latin-1 has control characters, from 0x80 to 0x9F.
const WINDOWS_1252: [char; 32] = [
    '\u{20AC}', '\u{81}', '\u{201A}', '\u{192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}', '\u{2C6}', '\u{2030}',
    '\u{160}', '\u{2039}', '\u{152}', '\u{8D}', '\u{17D}', '\u{8F}', '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}',
    '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}', '\u{2DC}', '\u{2122}', '\u{161}', '\u{203A}', '\u{153}', '\u{9D}',
    '\u{17E}', '\u{178}',
];

/// A file's bytes as text, or None for a file that isn't text. Read the way
/// Azure DevOps' own pages read one: by its byte-order mark if it has one,
/// as UTF-8 if it is that, and otherwise as Windows-1252. The mark itself
/// is not part of the text. As git has it, a file with a NUL in it is binary,
/// which UTF-16 without a mark therefore is.
pub fn decode(bytes: &[u8]) -> Option<String> {
    let utf16 = |rest: &[u8], unit: fn([u8; 2]) -> u16| {
        let units = rest.chunks(2).map(|pair| unit([pair[0], *pair.get(1).unwrap_or(&0)]));
        Some(char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)).collect())
    };
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => Some(String::from_utf8_lossy(rest).into_owned()),
        [0xFF, 0xFE, rest @ ..] => utf16(rest, u16::from_le_bytes),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, u16::from_be_bytes),
        _ if bytes.contains(&0) => None,
        _ => Some(match std::str::from_utf8(bytes) {
            Ok(text) => text.to_string(),
            Err(_) => bytes
                .iter()
                .map(|byte| match byte {
                    0x80..=0x9F => WINDOWS_1252[usize::from(byte - 0x80)],
                    _ => char::from(*byte),
                })
                .collect(),
        }),
    }
}

pub fn truncate(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        None => (text.to_string(), false),
        Some((at, _)) => (format!("{}…", text[..at].trim_end()), true),
    }
}

/// The last `max` lines, whether any were dropped, and how many there were.
pub fn tail(text: &str, max: usize) -> (String, bool, usize) {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= max {
        return (text.to_string(), false, lines.len());
    }
    (lines[lines.len() - max..].join("\n"), true, lines.len())
}

/// `2026-10-24T19:41:07Z`, from a Unix timestamp in seconds.
pub fn iso8601(epoch_secs: u64) -> String {
    let (days, secs) = (epoch_secs / 86_400, epoch_secs % 86_400);
    // Civil date from a day count (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Terminal colors, or none. Every piece of human output goes through one of these.
#[derive(Debug, Clone, Copy)]
pub struct Style {
    on: bool,
}

impl Style {
    pub const PLAIN: Style = Style { on: false };

    /// Colors, unless they were turned off or stdout isn't a terminal that does them.
    pub fn detect(turned_off: bool) -> Style {
        Style { on: !turned_off && console::colors_enabled() }
    }

    /// The same, for what goes to stderr.
    pub fn detect_stderr(turned_off: bool) -> Style {
        Style { on: !turned_off && console::colors_enabled_stderr() }
    }

    fn paint(self, code: &str, text: &str) -> String {
        if self.on {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    pub fn bold(self, text: &str) -> String {
        self.paint("1", text)
    }

    pub fn dim(self, text: &str) -> String {
        self.paint("2", text)
    }

    pub fn red(self, text: &str) -> String {
        self.paint("31", text)
    }

    pub fn green(self, text: &str) -> String {
        self.paint("32", text)
    }

    pub fn yellow(self, text: &str) -> String {
        self.paint("33", text)
    }

    /// A pipeline result: green when it succeeded, red when it failed, yellow while it's undecided.
    pub fn outcome(self, value: &str) -> String {
        match value {
            "succeeded" => self.green(value),
            v if v.contains("failed") || v.contains("canceled") => self.red(value),
            _ => self.yellow(value),
        }
    }
}

/// A boxed table. Cells may carry color codes; widths ignore them.
pub fn table(head: &[&str], rows: &[Vec<String>]) -> String {
    let width = console::measure_text_width;
    let widths: Vec<usize> = (0..head.len())
        .map(|col| rows.iter().map(|row| width(&row[col])).chain([width(head[col])]).max().unwrap_or(0))
        .collect();
    let rule = |left: &str, mid: &str, right: &str| {
        let bars: Vec<String> = widths.iter().map(|w| "─".repeat(w + 2)).collect();
        format!("{left}{}{right}", bars.join(mid))
    };
    let line = |cells: Vec<&str>| {
        let padded: Vec<String> =
            cells.iter().zip(&widths).map(|(cell, w)| format!(" {cell}{} ", " ".repeat(w - width(cell)))).collect();
        format!("│{}│", padded.join("│"))
    };
    let mut out = vec![rule("┌", "┬", "┐"), line(head.to_vec()), rule("├", "┼", "┤")];
    out.extend(rows.iter().map(|row| line(row.iter().map(String::as_str).collect())));
    out.push(rule("└", "┴", "┘"));
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tags_and_entities_keeping_line_structure() {
        assert_eq!(strip_html("<p>Click&nbsp;it</p>"), "Click it");
        assert_eq!(strip_html("<div>One</div><div>Two<br/>Three</div>"), "One\nTwo\nThree");
        assert_eq!(strip_html("<ul><li>a</li><li class=\"x\">b &amp; c</li></ul>"), "- a\n- b & c");
        assert_eq!(strip_html("a<br><br><br><br>b"), "a\n\nb");
        assert_eq!(strip_html("1 < 2 and &lt;b&gt;"), "1 < 2 and <b>");
        // A picture stays as a mark of where it is, however its tag is written.
        let shot = "https://dev.azure.com/contoso/_apis/wit/attachments/1b?fileName=a.png";
        assert_eq!(
            strip_html(&format!(
                "<div>See <img data-src=\"no\" SRC=\"{shot}&amp;x=1\" alt=Image width=3></div><img src='b.png'/>"
            )),
            format!("See ![Image]({shot}&x=1)\n![](b.png)")
        );
        assert_eq!(strip_html("<img alt=\"nothing to show\">text"), "text");
    }

    #[test]
    fn reads_a_files_bytes_as_the_text_they_are_whatever_they_are_written_in() {
        assert_eq!(decode("caf\u{e9} \u{1F642}\n".as_bytes()).as_deref(), Some("caf\u{e9} \u{1F642}\n"));
        assert_eq!(decode(b"").as_deref(), Some(""));
        // A byte-order mark says how to read the rest, and is not text itself.
        assert_eq!(decode(b"\xEF\xBB\xBFone\n").as_deref(), Some("one\n"));
        assert_eq!(decode(b"\xFF\xFEh\x00\xE9\x00\r\x00\n\x00").as_deref(), Some("h\u{e9}\r\n"));
        assert_eq!(decode(b"\xFE\xFF\x00h\x00\xE9\x00\n").as_deref(), Some("h\u{e9}\n"));
        assert_eq!(decode(b"\xFF\xFE=\xD8B\xDE").as_deref(), Some("\u{1F642}"));
        // Half a character at the end is not a reason to give up on the file.
        assert_eq!(decode(b"\xFF\xFEh\x00i").as_deref(), Some("hi"));
        // Not UTF-8: Windows-1252, as Azure DevOps reads it.
        assert_eq!(decode(b"caf\xE9 \x80 \x93x\x94\n").as_deref(), Some("caf\u{e9} \u{20AC} \u{201C}x\u{201D}\n"));
        // A NUL means it isn't text, which is what UTF-16 with no mark looks like too.
        assert_eq!(decode(b"PNG\x00\x01"), None);
        assert_eq!(decode(b"h\x00i\x00"), None);
    }

    #[test]
    fn truncates_by_characters_and_tails_by_lines() {
        assert_eq!(truncate("héllo wörld", 6), ("héllo…".to_string(), true));
        assert_eq!(truncate("short", 10), ("short".to_string(), false));
        assert_eq!(tail("a\nb\nc", 2), ("b\nc".to_string(), true, 3));
    }

    #[test]
    fn formats_timestamps() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_800_000_000), "2027-01-15T08:00:00Z");
        assert_eq!(iso8601(1_709_210_096), "2024-02-29T12:34:56Z");
    }

    #[test]
    fn draws_a_table_sized_to_its_widest_cells() {
        let rows = vec![vec!["#1".to_string(), "Bug".to_string()], vec!["#4821".to_string(), "Task".to_string()]];
        assert_eq!(table(&["ID", "Type"], &rows), "┌───────┬──────┐\n│ ID    │ Type │\n├───────┼──────┤\n│ #1    │ Bug  │\n│ #4821 │ Task │\n└───────┴──────┘");
    }
}
