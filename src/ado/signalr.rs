use super::{
    sections::{Resource, Section, Section::*, Sections},
    Request, Transport,
};
use crate::error::{Error, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use reqwest_websocket::{Message, Upgrade, WebSocket};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::timeout;
use url::Url;

const HANDSHAKE: Duration = Duration::from_secs(20);

pub struct Hub {
    socket: WebSocket,
    /// Callbacks may precede (or share a frame with) the subscribe acknowledgement.
    pub pending: Sections,
    idle_timeout: Duration,
    resource: Resource,
    id: u64,
}

impl Hub {
    pub async fn connect(
        http: &Client,
        transport: &dyn Transport,
        base: &str,
        host: &str,
        resource: Resource,
        id: u64,
        args: Value,
        bearer: &str,
    ) -> Result<Self> {
        timeout(HANDSHAKE, Self::handshake(http, transport, base, host, resource, id, args, bearer))
            .await
            .map_err(|_| Error::external("Timed out subscribing to Azure DevOps updates."))?
    }

    async fn handshake(
        http: &Client,
        transport: &dyn Transport,
        base: &str,
        host: &str,
        resource: Resource,
        id: u64,
        args: Value,
        bearer: &str,
    ) -> Result<Self> {
        let mut params = vec![
            ("contextToken", host.to_owned()),
            ("clientProtocol", "1.5".into()),
            ("connectionData", json!([{"name":resource.hub()}]).to_string()),
        ];
        let endpoint = |action: &str, params: &[(&str, String)]| -> Result<Url> {
            Url::parse_with_params(&format!("{base}/{action}"), params)
                .map_err(|_| Error::user("Invalid live hub address."))
        };
        let control = |url: Url| {
            let response = transport.send(&Request::get(url.to_string()))?;
            if matches!(response.status, 401 | 203) {
                return Err(Error::prereq("Azure refused the live hub credentials."));
            }
            if !(200..300).contains(&response.status) {
                return Err(Error::external(format!("Azure live hub returned HTTP {}.", response.status)));
            }
            serde_json::from_str::<Value>(&response.body)
                .map_err(|_| Error::external("Invalid Azure live hub response."))
        };
        let negotiation = control(endpoint("negotiate", &params)?)?;
        let connection = negotiation["ConnectionToken"]
            .as_str()
            .ok_or_else(|| Error::external("Azure did not negotiate a live hub connection."))?;
        params.extend([("connectionToken", connection.to_owned()), ("transport", "webSockets".into())]);
        let socket = http
            .get(endpoint("connect", &params)?)
            .bearer_auth(bearer)
            .upgrade()
            .send()
            .await
            .map_err(|_| Error::external("Could not connect the Azure live WebSocket."))?
            .into_websocket()
            .await
            .map_err(|_| Error::external("Azure refused the live WebSocket upgrade."))?;
        let idle = negotiation["KeepAliveTimeout"].as_f64().unwrap_or(30.0);
        let mut hub = Hub {
            socket,
            resource,
            id,
            pending: Sections::new(),
            idle_timeout: Duration::from_secs_f64((idle * 2.0).clamp(30.0, 180.0)),
        };
        let init = hub.frame().await?;
        if init["S"] != 1 || control(endpoint("start", &params)?)?["Response"] != "started" {
            return Err(Error::external("Azure did not start the live hub connection."));
        }
        let method = match resource {
            Resource::Pr => "Subscribe",
            Resource::Wi => "WatchWorkItem",
        };
        hub.socket
            .send(Message::Text(json!({"H":resource.hub(),"M":method,"A":args,"I":0}).to_string()))
            .await
            .map_err(|_| Error::external("Could not subscribe to live updates."))?;
        loop {
            let frame = hub.frame().await?;
            hub.pending.extend(changed(resource, id, &frame));
            if frame["I"] == 0 || frame["I"] == "0" {
                if !frame["E"].is_null() {
                    return Err(Error::external("Azure rejected the live subscription."));
                }
                return Ok(hub);
            }
        }
    }

    async fn frame(&mut self) -> Result<Value> {
        loop {
            let raw = timeout(self.idle_timeout, self.socket.next())
                .await
                .map_err(|_| Error::external("Azure stopped sending live hub keepalives."))?;
            match raw {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value =
                        serde_json::from_str(&text).map_err(|_| Error::external("Invalid Azure live hub frame."))?;
                    if frame["T"] == 1 || frame["D"] == 1 || frame["T"] == true || frame["D"] == true {
                        return Err(Error::external("Azure requested a new live hub connection."));
                    }
                    return Ok(frame);
                }
                Some(Ok(Message::Ping(bytes))) => self
                    .socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| Error::external("Azure live hub disconnected."))?,
                Some(Ok(Message::Pong(_))) => {}
                _ => return Err(Error::external("Azure live hub disconnected.")),
            }
        }
    }

    pub async fn next(&mut self) -> Result<Sections> {
        Ok(changed(self.resource, self.id, &self.frame().await?))
    }
}

fn changed(resource: Resource, id: u64, frame: &Value) -> Sections {
    let mut found = Sections::new();
    for m in frame["M"].as_array().into_iter().flatten() {
        if !m["H"].as_str().is_some_and(|h| h.eq_ignore_ascii_case(resource.hub())) {
            continue;
        }
        let method = m["M"].as_str().unwrap_or_default().to_ascii_lowercase();
        if resource == Resource::Wi {
            if method == "onworkitemupdated" {
                found.extend(ticket_changes(&m["A"], id));
            }
            continue;
        }
        let sections: &[Section] = match method.as_str() {
            "ondiscussionsupdated" => &[Discussion],
            "onpolicyevaluationupdated" => &[Checks],
            "onstatusadded" | "onstatusupdated" | "onstatusesdeleted" => &[Statuses],
            "ontitledescriptionupdated" => &[Details, Discussion],
            "onreviewervoteupdated" | "onreviewersvotesreset" | "onreviewersupdated" => {
                &[Reviewers, Discussion, Checks]
            }
            "onautocompleteupdated" => &[Details, Checks, Discussion],
            "onlabelsupdated" => &[Labels],
            "onrealtimepullrequestupdated" => &[],
            _ => return resource.sections(),
        };
        found.extend(sections);
    }
    found
}

fn ticket_changes(args: &Value, id: u64) -> Sections {
    let mut sections = Sections::new();
    for update in args.as_array().into_iter().flatten().filter_map(Value::as_array).flatten() {
        if update["id"].as_u64() != Some(id) {
            continue;
        }
        match (update["isCommentReactionUpdate"] == true, update["linkOnlyUpdate"] == true) {
            (true, false) => {
                sections.insert(Comments);
            }
            (false, true) => sections.extend([Details, Relations]),
            _ => return Resource::Wi.sections(),
        }
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boards_callbacks_filter_the_watched_id_and_merge_all_matching_updates() {
        let events = |updates| {
            changed(
                Resource::Wi,
                3,
                &json!({"M":[
            {"H":"PullRequestDetailHub","M":"OnLabelsUpdated","A":[]},
            {"H":"WorkItemHub","M":"OnWorkItemUpdated","A":[updates]}]}),
            )
        };
        assert!(events(json!([{"id":4}])).is_empty());
        assert_eq!(events(json!([{"id":4},{"id":3,"isCommentReactionUpdate":true}])), [Comments].into());
        assert_eq!(events(json!([{"id":3,"linkOnlyUpdate":true}])), [Details, Relations].into());
        assert_eq!(events(json!([{"id":3,"revision":29,"changeType":"change"}])), Resource::Wi.sections());
        assert_eq!(
            events(json!([{"id":3,"linkOnlyUpdate":true},{"id":3,"isCommentReactionUpdate":true}])),
            Resource::Wi.sections()
        );
    }
}
