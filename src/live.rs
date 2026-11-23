use crate::ado::{
    client::AdoClient,
    sections::{Resource, Sections},
    signalr::Hub,
    types::PullRequest,
    Transport,
};
use crate::app::App;
use crate::error::{Error, Result};
use crate::rpc::RpcError;
use crate::{config, urls};
use reqwest::Client;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::{
    runtime::{Builder, Runtime},
    task::JoinHandle,
};

type Params = Map<String, Value>;
type SendMessage = Arc<dyn Fn(Value) + Send + Sync>;

#[cfg(test)]
mod tests;

struct Target {
    transport: Arc<dyn Transport>,
    org_url: String,
    org: String,
    item: Item,
    hub_url: String,
    host: String,
}

enum Item {
    Pr(Box<PullRequest>),
    Wi { id: u64, project: Mutex<Option<String>> },
}

impl Target {
    fn resolve(app: App, resource: Resource, id: u64) -> Result<Self> {
        let org_url = app.org_url(None)?;
        let ado = app.ado(&org_url);
        let (item, hub_path) = match resource {
            Resource::Pr => {
                let pr = ado.pull_request(id)?;
                let project = pr
                    .project_id
                    .as_ref()
                    .filter(|s| config::valid_id(s))
                    .ok_or_else(|| Error::external("Missing PR project GUID."))?;
                let path = format!("/_apis/{project}/signalr");
                if !pr.repo_id.as_ref().is_some_and(|s| config::valid_id(s)) {
                    return Err(Error::external("Missing PR repository GUID."));
                }
                (Item::Pr(Box::new(pr)), path)
            }
            Resource::Wi => (Item::Wi { id, project: Mutex::default() }, "/signalr".into()),
        };
        let org = org_url
            .strip_prefix("https://dev.azure.com/")
            .filter(|s| config::valid_name(s))
            .ok_or_else(|| Error::user("Invalid organization for a live view."))?
            .to_owned();
        let host = config::saved_org(&app.env)?
            .filter(|saved| saved.name.eq_ignore_ascii_case(&org))
            .ok_or_else(|| Error::user("Organization is not configured."))?
            .id;
        let hub_url = format!("{org_url}{hub_path}");
        Ok(Self { transport: app.transport, org_url, org, item, hub_url, host })
    }

    fn resource(&self) -> Resource {
        match self.item {
            Item::Pr(_) => Resource::Pr,
            Item::Wi { .. } => Resource::Wi,
        }
    }

    fn read(&self, sections: &Sections) -> Result<Value> {
        let ado = AdoClient::new(self.transport.as_ref(), &self.org_url);
        match &self.item {
            Item::Pr(pr) => Ok(ado.read_pr(pr, sections)?.snapshot),
            Item::Wi { id, project } => {
                Ok(ado.read_ticket(*id, sections, &mut project.lock().unwrap())?.snapshot(&self.org_url, sections))
            }
        }
    }

    async fn load(self: &Arc<Self>, sections: Sections) -> Result<Value> {
        let target = self.clone();
        tokio::task::spawn_blocking(move || target.read(&sections))
            .await
            .map_err(|_| Error::external("Could not read live Azure data."))?
    }

    async fn subscribe(self: &Arc<Self>, http: &Client) -> Result<Hub> {
        let target = self.clone();
        let bearer = tokio::task::spawn_blocking(move || target.transport.token(&target.org))
            .await
            .map_err(|_| Error::external("Could not load Azure credentials."))??;
        let (id, args) = match &self.item {
            Item::Pr(pr) => (pr.id, json!([pr.id, pr.repo_id])),
            Item::Wi { id, .. } => (*id, json!([id])),
        };
        Hub::connect(http, self.transport.as_ref(), &self.hub_url, &self.host, self.resource(), id, args, &bearer).await
    }

    async fn synchronized(self: &Arc<Self>, http: &Client) -> Result<(Hub, Value)> {
        let hub = self.subscribe(http).await?;
        let snapshot = self.load(self.resource().sections()).await?;
        Ok((hub, snapshot))
    }

    async fn listen(self: Arc<Self>, mut hub: Hub, id: String, send: SendMessage) {
        let event = |method: &str, mut params: Value| {
            params["subscription"] = json!(id);
            let name = format!("{}.{method}", self.resource().prefix());
            send(json!({"jsonrpc":"2.0","method":name,"params":params}));
        };
        loop {
            let sections = if hub.pending.is_empty() {
                match hub.next().await {
                    Ok(sections) => sections,
                    Err(_) => break,
                }
            } else {
                std::mem::take(&mut hub.pending)
            };
            match self.load(sections).await {
                Ok(changes) => event("changed", json!({"changes":changes})),
                Err(_) => break,
            }
        }
        event("disconnected", json!({}));
    }
}

pub struct Session {
    send: SendMessage,
    next: AtomicU64,
    entries: Mutex<HashMap<String, JoinHandle<()>>>,
    runtime: Runtime,
    http: Client,
}

impl Session {
    pub fn new(send: SendMessage) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = Client::builder()
            .http1_only()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::external("Could not initialize the live connection."))?;
        let runtime = Builder::new_multi_thread().worker_threads(1).enable_all().build()?;
        Ok(Self { send, next: AtomicU64::new(1), entries: Mutex::default(), runtime, http })
    }

    pub fn open(
        &self,
        app: App,
        resource: Resource,
        params: &Params,
        reply: impl FnOnce(Value),
    ) -> Result<(), RpcError> {
        let id = params
            .get("id")
            .and_then(|v| v.as_u64().or_else(|| urls::parse_id(v.as_str()?)))
            .filter(|id| *id > 0)
            .ok_or_else(|| RpcError::new(-32602, "Expected a positive resource id."))?;
        Ok(self.open_target(Arc::new(Target::resolve(app, resource, id)?), reply)?)
    }

    fn open_target(&self, target: Arc<Target>, reply: impl FnOnce(Value)) -> Result<()> {
        let (hub, snapshot) = self.runtime.block_on(target.synchronized(&self.http))?;
        let id = format!("s{}", self.next.fetch_add(1, Ordering::Relaxed));
        // Each RPC request runs on its own thread, so a close can arrive as soon as the reply is
        // written. Holding the table until the listener is in it makes that close wait for it.
        let mut entries = self.entries.lock().unwrap();
        reply(json!({"subscription":id, "snapshot":snapshot}));
        let listener = self.runtime.spawn(target.listen(hub, id.clone(), self.send.clone()));
        entries.insert(id, listener);
        Ok(())
    }

    pub fn close(&self, params: &Params) -> Result<Value, RpcError> {
        let id = params
            .get("subscription")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::new(-32602, "Expected a subscription ID."))?;
        let listener = self
            .entries
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| RpcError::new(-32602, "Unknown subscription in this session."))?;
        listener.abort();
        // Finish any in-flight notification before acknowledging close.
        let _ = self.runtime.block_on(listener);
        Ok(Value::Null)
    }
}
