use super::*;
use crate::testing::{fake_ado, ok, rest_pr};
use std::{net::TcpListener, sync::mpsc, thread, time::Duration};
use tungstenite::Message;

const LIMIT: Duration = Duration::from_secs(8);

#[test]
fn replies_before_queued_changes_and_stops_after_a_disconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/acme", listener.local_addr().unwrap());
    let (release, commands) = mpsc::channel::<()>();
    let socket = thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        conn.set_read_timeout(Some(LIMIT)).unwrap();
        let mut ws = tungstenite::accept(conn).unwrap();
        let text = |v: Value| Message::text(v.to_string());
        let callback = |m| json!({"M":[{"H":"pullrequestdetailhub","M":m,"A":[]}]});
        ws.send(text(json!({"S":1}))).unwrap();
        let sub: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(sub["A"], json!([9, "repo"]));
        ws.send(text(callback("onDiscussionsUpdated"))).unwrap();
        ws.send(text(json!({"I":"0"}))).unwrap();
        commands.recv_timeout(LIMIT).unwrap();
        ws.send(text(json!({"M":[{"H":"PullRequestDetailHub","M":"OnLabelsUpdated","A":[]}]}))).unwrap();
        commands.recv_timeout(LIMIT).unwrap();
        ws.send(text(json!({"D":1}))).unwrap();
    });
    let ado = Arc::new(fake_ado(Box::new(|r| {
        if r.path.ends_with("/negotiate") {
            return ok(json!({"ConnectionToken":"test"}));
        }
        if r.path.ends_with("/start") {
            return ok(json!({"Response":"started"}));
        }
        if r.path.ends_with("/workitems") {
            return ok(json!({"value":[]}));
        }
        let mask = &r.body["dataProviderContext"]["properties"]["types"];
        let data = match mask.as_u64().unwrap() {
            1019 => json!({"pullRequest":rest_pr(9,json!({"title":"snapshot","reviewers":[]})),
                "discussionThreads":[],"latestIterationId":2,"iterations":[{"id":2,"commonRefCommit":{"commitId":"base"},"sourceRefCommit":{"commitId":"head"}}],
                "latestChanges":{"changeEntries":[]},"labels":[],"policies":[],"statuses":[]}),
            792 => json!({"discussionThreads":[]}),
            32 => json!({"labels":[{"name":"updated"}]}),
            mask => panic!("unexpected mask {mask}"),
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
    assert_eq!(opened["snapshot"]["details"]["title"], "snapshot");
    let params = json!({"subscription":opened["subscription"]});
    assert_eq!(next()["params"]["changes"], json!({"discussion":[]}));
    release.send(()).unwrap();
    assert_eq!(next()["params"]["changes"], json!({"labels":[{"name":"updated"}]}));
    release.send(()).unwrap();
    assert_eq!(next()["method"], "pr.disconnected");
    session.close(params.as_object().unwrap()).unwrap();
    socket.join().unwrap();
    assert!(client.try_recv().is_err());
}
