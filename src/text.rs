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
        let tag = rest[open + 1..open + len].trim_end_matches('/').trim().to_ascii_lowercase();
        let name = tag.split_whitespace().next().unwrap_or("");
        match name {
            "br" | "/p" | "/div" | "/li" => text.push('\n'),
            "li" => text.push_str("- "),
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

/// Cuts text at `max` characters, saying whether it did so callers can offer `--full`.
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
