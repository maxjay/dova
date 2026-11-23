use super::*;
use crate::testing::{fake_ado, ok, rest_pr};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
};
use tungstenite::Message;

const LIMIT: Duration = Duration::from_secs(8);

fn control(listener: &TcpListener, verb: &str, result: Value) {
    let (mut socket, _) = listener.accept().unwrap();
    socket.set_read_timeout(Some(LIMIT)).unwrap();
    let mut headers = String::new();
    let mut reader = BufReader::new(&socket);
    loop {
        let mut line = String::new();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        headers += &line;
    }
    assert!(headers.starts_with(&format!("GET /{verb}?")));
    assert!(headers.to_ascii_lowercase().contains("authorization: bearer test-token"));
    let data = result.to_string();
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",
        data.len()
    )
    .unwrap();
}

#[test]
fn replies_before_queued_changes_and_reconciles_after_a_disconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (release, commands) = mpsc::channel::<()>();
    let socket = thread::spawn(move || {
        for attempt in 0..2 {
            control(&listener, "negotiate", json!({"ConnectionToken":"test"}));
            let (conn, _) = listener.accept().unwrap();
            conn.set_read_timeout(Some(LIMIT)).unwrap();
            let mut ws = tungstenite::accept(conn).unwrap();
            let text = |v: Value| Message::text(v.to_string());
            let callback = |m| json!({"M":[{"H":"pullrequestdetailhub","M":m,"A":[]}]});
            ws.send(text(json!({"S":1}))).unwrap();
            control(&listener, "start", json!({"Response":"started"}));
            let sub: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(sub["A"], json!([9, "repo"]));
            ws.send(text(callback("onDiscussionsUpdated"))).unwrap();
            ws.send(text(json!({"I":"0"}))).unwrap();
            if attempt == 0 {
                commands.recv_timeout(LIMIT).unwrap();
                ws.send(text(json!({"M":[{"H":"PullRequestDetailHub","M":"OnLabelsUpdated","A":[]}]}))).unwrap();
                commands.recv_timeout(LIMIT).unwrap();
                ws.send(text(json!({"D":1}))).unwrap();
            } else {
                assert!(ws.read().is_err() || !ws.can_read(), "listener must release the socket on close");
            }
        }
    });
    let restores = Arc::new(AtomicU64::new(0));
    let count = restores.clone();
    let ado = Arc::new(fake_ado(Box::new(move |r| {
        if r.path.ends_with("/workitems") {
            return ok(json!({"value":[]}));
        }
        let mask = &r.body["dataProviderContext"]["properties"]["types"];
        let data = if mask == 1019 {
            let n = count.fetch_add(1, Ordering::SeqCst);
            json!({"pullRequest":rest_pr(9,json!({"title":format!("snapshot {n}"),"reviewers":[]})),
                "discussionThreads":[],"latestIterationId":2,"iterations":[{"id":2,"commonRefCommit":{"commitId":"base"},"sourceRefCommit":{"commitId":"head"}}],
                "latestChanges":{"changeEntries":[]},"labels":[],"policies":[],"statuses":[]})
        } else {
            assert_eq!(mask, 32);
            json!({"labels":[{"name":"updated"}]})
        };
        ok(json!({"dataProviders":{"ms.vss-code-web.pr-detail-data-provider":data}}))
    })));
    let pr = crate::ado::map::to_pull_request(&rest_pr(9, json!({})), "https://dev.azure.com/acme", "project", "repo");
    let mut pr = pr;
    pr.repo_id = Some("repo".into());
    let target = Arc::new(Target {
        transport: ado,
        org_url: "https://dev.azure.com/acme".into(),
        org: "acme".into(),
        item: Item::Pr(Box::new(pr)),
        hub_url: base,
        host: "host".into(),
    });
    let (messages, client) = mpsc::channel();
    let replies = messages.clone();
    let session = Session::new(Arc::new(move |m| messages.send(m).unwrap())).unwrap();
    session.open_target(target, |reply| replies.send(reply).unwrap()).unwrap();
    let next = || client.recv_timeout(LIMIT).unwrap();
    let opened = next();
    assert_eq!(opened["snapshot"]["details"]["title"], "snapshot 0");
    let params = json!({"subscription":opened["subscription"],"sections":["labels"]});
    assert_eq!(next()["params"]["sections"], json!(["discussion"]));
    release.send(()).unwrap();
    assert_eq!(next()["params"]["sections"], json!(["labels"]));
    assert_eq!(
        session.read(Resource::Pr, params.as_object().unwrap()).unwrap(),
        json!({"labels":[{"name":"updated"}]})
    );
    assert!(session.close(Resource::Wi, params.as_object().unwrap()).is_err());
    release.send(()).unwrap();
    assert_eq!(next()["method"], "pr.disconnected");
    let resync = next();
    assert_eq!(resync["method"], "pr.resynced");
    assert_eq!(resync["params"]["snapshot"]["details"]["title"], "snapshot 1");
    assert_eq!(next()["params"]["sections"], json!(["discussion"]));
    session.close(Resource::Pr, params.as_object().unwrap()).unwrap();
    assert!(session.read(Resource::Pr, params.as_object().unwrap()).is_err());
    socket.join().unwrap();
    assert!(client.try_recv().is_err());
}
