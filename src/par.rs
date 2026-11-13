//! Requests that don't depend on each other run at the same time, on scoped
//! threads. A command makes a handful of them, so that's all it takes.

use std::panic::resume_unwind;
use std::thread;

pub fn join<A: Send, B: Send>(a: impl FnOnce() -> A + Send, b: impl FnOnce() -> B + Send) -> (A, B) {
    thread::scope(|s| {
        let b = s.spawn(b);
        (a(), b.join().unwrap_or_else(|panic| resume_unwind(panic)))
    })
}

pub fn join3<A: Send, B: Send, C: Send>(
    a: impl FnOnce() -> A + Send,
    b: impl FnOnce() -> B + Send,
    c: impl FnOnce() -> C + Send,
) -> (A, B, C) {
    let (a, (b, c)) = join(a, || join(b, c));
    (a, b, c)
}

/// `f` over every item at once, results in the items' order.
pub fn map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    match items {
        [] => Vec::new(),
        [only] => vec![f(only)],
        _ => thread::scope(|s| {
            let handles: Vec<_> = items.iter().map(|item| s.spawn(|| f(item))).collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|panic| resume_unwind(panic))).collect()
        }),
    }
}
