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
use serde_json::{json, Map, Value};
use std::collections::{hash_map::Entry, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::{
    runtime::{Builder, Runtime},
    sync::oneshot,
    task::JoinHandle,
    time::sleep,
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
        let host = match config::saved_org(&app.env)?.filter(|saved| saved.name.eq_ignore_ascii_case(&org)) {
            Some(saved) => saved.id,
            None => ado.connection_data()?["instanceId"]
                .as_str()
                .filter(|s| config::valid_id(s))
                .ok_or_else(|| Error::external("Azure did not return the organization GUID."))?
                .to_owned(),
        };
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
            Item::Pr(pr) => Ok(ado.read_pr(pr, sections)?.snapshot(sections)),
            Item::Wi { id, project } => {
                Ok(ado.read_ticket(*id, sections, &mut project.lock().unwrap())?.snapshot(&self.org_url, sections))
            }
        }
    }

    async fn subscribe(self: &Arc<Self>) -> Result<Hub> {
        let target = self.clone();
        let bearer = tokio::task::spawn_blocking(move || target.transport.token(&target.org))
            .await
            .map_err(|_| Error::external("Could not load Azure credentials."))??;
        let (id, args) = match &self.item {
            Item::Pr(pr) => (pr.id, json!([pr.id, pr.repo_id])),
            Item::Wi { id, .. } => (*id, json!([id])),
        };
        let connect = |args, bearer: String| async move {
            Hub::connect(&self.hub_url, &self.host, self.resource(), id, args, &bearer).await
        };
        match connect(args.clone(), bearer).await {
            Err(err) if err.kind == crate::error::Kind::Prereq => {
                // A saved org can belong to a different Entra tenant than az's
                // default. The REST transport handles the tenant challenge.
                let target = self.clone();
                let token = tokio::task::spawn_blocking(move || {
                    AdoClient::new(target.transport.as_ref(), &target.org_url).connection_data()?;
                    target.transport.token(&target.org)
                })
                .await
                .map_err(|_| Error::external("Could not refresh Azure credentials."))??;
                connect(args, token).await
            }
            result => result,
        }
    }

    /// Buffer changed sections while the snapshot is loading.
    async fn synchronized(self: &Arc<Self>) -> Result<(Hub, Value)> {
        let mut hub = self.subscribe().await?;
        let target = self.clone();
        let mut snapshot = tokio::task::spawn_blocking(move || target.read(&target.resource().sections()));
        loop {
            tokio::select! {
                result = &mut snapshot => return Ok((hub, result.map_err(|_| Error::external("Could not read the live snapshot."))??)),
                event = hub.next() => hub.pending.extend(event?),
            }
        }
    }

    async fn listen(self: Arc<Self>, mut hub: Hub, id: String, send: SendMessage) {
        let event = |method: &str, mut params: Value| {
            params["subscription"] = json!(id);
            let name = format!("{}.{method}", self.resource().prefix());
            send(json!({"jsonrpc":"2.0","method":name,"params":params}));
        };
        loop {
            if !hub.pending.is_empty() {
                event("changed", json!({"sections":std::mem::take(&mut hub.pending)}));
            }
            match hub.next().await {
                Ok(sections) => {
                    hub.pending = sections;
                    continue;
                }
                Err(_) => event("disconnected", json!({})),
            }
            drop(hub);
            let mut delay = 1;
            loop {
                sleep(Duration::from_secs(delay)).await;
                if let Ok((new_hub, snapshot)) = self.synchronized().await {
                    event("resynced", json!({"snapshot":snapshot}));
                    hub = new_hub;
                    break;
                }
                delay = (delay * 2).min(30);
            }
        }
    }
}

struct Subscription {
    target: Arc<Target>,
    listener: JoinHandle<()>,
}

pub struct Session {
    send: SendMessage,
    next: AtomicU64,
    entries: Mutex<HashMap<String, Subscription>>,
    runtime: Runtime,
}

impl Session {
    pub fn new(send: SendMessage) -> Result<Self> {
        let runtime = Builder::new_multi_thread().worker_threads(1).enable_all().build()?;
        Ok(Self { send, next: AtomicU64::new(1), entries: Mutex::default(), runtime })
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
        let (hub, snapshot) = self.runtime.block_on(target.synchronized())?;
        let id = format!("s{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (start, ready) = oneshot::channel();
        let watched = target.clone();
        let subscription = id.clone();
        let send = self.send.clone();
        let listener = self.runtime.spawn(async move {
            if ready.await.is_ok() {
                watched.listen(hub, subscription, send).await;
            }
        });
        self.entries.lock().unwrap().insert(id.clone(), Subscription { target, listener });
        reply(json!({"subscription":id, "snapshot":snapshot}));
        let _ = start.send(());
        Ok(())
    }

    pub fn read(&self, resource: Resource, params: &Params) -> Result<Value, RpcError> {
        let id = subscription_id(params)?;
        let sections: Sections = serde_json::from_value(params.get("sections").cloned().unwrap_or(Value::Null))
            .map_err(|_| RpcError::new(-32602, "Expected a list of section names."))?;
        if sections.is_empty() || !sections.is_subset(&resource.sections()) {
            return Err(RpcError::new(-32602, "Request one or more sections belonging to this resource."));
        }
        let target = self
            .entries
            .lock()
            .unwrap()
            .get(id)
            .filter(|sub| sub.target.resource() == resource)
            .map(|sub| sub.target.clone())
            .ok_or_else(unknown)?;
        Ok(target.read(&sections)?)
    }

    pub fn close(&self, resource: Resource, params: &Params) -> Result<Value, RpcError> {
        let id = subscription_id(params)?;
        let listener = match self.entries.lock().unwrap().entry(id.to_owned()) {
            Entry::Occupied(entry) if entry.get().target.resource() == resource => entry.remove().listener,
            _ => return Err(unknown()),
        };
        listener.abort();
        // Finish any in-flight notification before acknowledging close.
        let _ = self.runtime.block_on(listener);
        Ok(Value::Null)
    }
}

fn subscription_id(params: &Params) -> Result<&str, RpcError> {
    params
        .get("subscription")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(-32602, "Expected a subscription ID."))
}

fn unknown() -> RpcError {
    RpcError::new(-32602, "Unknown subscription for this resource in this session.")
}
