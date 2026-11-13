//! One file per area. Each command is a struct of its arguments with a
//! `run`; the logic it shares with other commands is a plain function
//! beside it.

pub mod link;
pub mod misc;
pub mod pipeline;
pub mod pr;
pub mod status;
pub mod summarize;
pub mod wi;

use crate::ado::types::WorkItemRef;
use crate::text::table;

/// Work items as a table: the same wherever they're listed.
pub fn work_item_table(items: &[WorkItemRef]) -> String {
    let text = |value: &Option<String>| value.clone().unwrap_or_else(|| "?".into());
    let rows: Vec<Vec<String>> =
        items.iter().map(|w| vec![format!("#{}", w.id), text(&w.kind), text(&w.title), text(&w.state)]).collect();
    table(&["ID", "Type", "Title", "State"], &rows)
}
