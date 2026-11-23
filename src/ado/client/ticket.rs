use super::{AdoClient, COMMENTS};
use crate::ado::map::to_work_item;
use crate::ado::sections::{Section, Sections};
use crate::ado::types::WorkItemRef;
use crate::error::{Error, Result};
use crate::{par, urls};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct TicketRead {
    pub item: Value,
    pub relations: Vec<Value>,
    pub linked: HashMap<u64, WorkItemRef>,
    pub comments: Vec<Value>,
}

impl TicketRead {
    pub fn snapshot(mut self, org: &str, sections: &Sections) -> Value {
        let mut result = json!({});
        if sections.contains(&Section::Details) {
            let mut details = json!(to_work_item(&self.item, org));
            details["revision"] = self.item["rev"].take();
            details["fields"] = self.item["fields"].take();
            result["details"] = details;
        }
        if sections.contains(&Section::Relations) {
            for link in &mut self.relations {
                if let Some(id) = link["workItemId"].as_u64() {
                    link["workItem"] = json!(self.linked.get(&id));
                }
            }
            result["relations"] = Value::Array(self.relations);
        }
        if sections.contains(&Section::Comments) {
            result["comments"] = json!(self.comments);
        }
        result
    }
}

impl AdoClient<'_> {
    pub fn read_ticket(&self, id: u64, sections: &Sections, project: &mut Option<String>) -> Result<TicketRead> {
        use Section::*;
        let links = sections.contains(&Relations);
        let mut item = Value::Null;
        let mut ids = Vec::new();
        let mut relations: Vec<Value> = Vec::new();
        if sections.contains(&Details) || links || project.is_none() {
            let path = format!("_apis/wit/workitems/{id}");
            let expand = if links { "relations" } else { "none" };
            item = self.get(&path, &[("$expand", expand)]).map_err(|err| {
                if err.kind == crate::error::Kind::NotFound {
                    Error::not_found(format!("Work item #{id} was not found."))
                } else {
                    err
                }
            })?;
            if item["id"].as_u64() != Some(id) || !item["rev"].is_u64() {
                return Err(Error::external("Invalid work item returned by Azure DevOps."));
            }
            let name = item["fields"]["System.TeamProject"]
                .as_str()
                .ok_or_else(|| Error::external("Missing work item project."))?;
            *project = Some(name.to_owned());
            if links {
                ids.extend(item["fields"]["System.Parent"].as_u64());
                if let Some(raw) = item.get_mut("relations").filter(|v| !v.is_null()) {
                    relations = serde_json::from_value(raw.take())
                        .map_err(|_| Error::external("Invalid work item relations."))?;
                }
                for link in &mut relations {
                    if matches!(link["rel"].as_str(), Some("Hyperlink" | "ArtifactLink" | "AttachedFile")) {
                        continue;
                    }
                    if let Some(id) = link["url"].as_str().and_then(|url| urls::linked_work_item(&self.org_url, url)) {
                        link["workItemId"] = json!(id);
                        ids.push(id);
                    }
                }
            }
        }
        let (linked, comments) = par::join(
            || self.work_item_refs(&ids),
            || match project.as_deref() {
                Some(name) if sections.contains(&Comments) && item["fields"]["System.CommentCount"] != 0 => {
                    self.ticket_comments(name, id)
                }
                _ => Ok(Vec::new()),
            },
        );
        Ok(TicketRead {
            item,
            relations,
            linked: linked?.into_iter().map(|w| (w.id, w)).collect(),
            comments: comments?,
        })
    }

    fn ticket_comments(&self, project: &str, id: u64) -> Result<Vec<Value>> {
        let path = format!("{}/_apis/wit/workItems/{id}/comments", urls::enc(project));
        let mut comments = Vec::new();
        let mut token = String::new();
        let mut seen = HashSet::new();
        loop {
            let mut query =
                vec![("api-version", COMMENTS), ("$top", "200"), ("order", "asc"), ("$expand", "reactions")];
            if !token.is_empty() {
                query.push(("continuationToken", &token));
            }
            let mut page = self.get(&path, &query)?;
            comments.append(
                page["comments"]
                    .as_array_mut()
                    .ok_or_else(|| Error::external("Invalid Azure work item comments page."))?,
            );
            let Some(next) = page["continuationToken"].as_str().filter(|t| !t.is_empty()) else { break };
            if !seen.insert(next.to_owned()) {
                return Err(Error::external("Azure repeated a work item comments continuation token."));
            }
            token = next.to_owned();
        }
        Ok(comments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ado::sections::Resource;
    use crate::testing::{fake_ado, ok, wi};
    #[test]
    fn snapshot_batches_local_links_and_a_comments_only_read_follows_its_cursor() {
        let ado = fake_ado(Box::new(|r| {
            if r.path.ends_with("/workitems/3") {
                assert_eq!(r.query("$expand").as_deref(), Some("relations"));
                return ok(json!({"id":3,"rev":2,"fields":{"System.TeamProject":"Project","Custom.Field":"abc"},
                "relations":[
                  {"rel":"System.LinkTypes.Related","url":"https://dev.azure.com/acme/other/_apis/wit/workitems/5"},
                  {"rel":"System.LinkTypes.Related","url":"https://acme.visualstudio.com/DefaultCollection/_apis/wit/workItems/5"},
                  {"rel":"System.LinkTypes.Related","url":"https://dev.azure.com/elsewhere/_apis/wit/workitems/7"},
                  {"rel":"AttachedFile","url":"https://dev.azure.com/acme/_apis/wit/attachments/a"}
                ]}));
            }
            if r.path.ends_with("/workitemsbatch") {
                assert_eq!(r.body["ids"], json!([5]));
                assert_eq!(r.body["fields"], json!(["System.Title", "System.WorkItemType", "System.State"]));
                return ok(json!({"value":[wi(5,json!({}))]}));
            }
            assert!(r.path.ends_with("/Project/_apis/wit/workItems/3/comments"));
            assert_eq!(r.query("$expand").as_deref(), Some("reactions"));
            match r.query("continuationToken").as_deref() {
                None => ok(json!({"comments":[{"id":1}],"continuationToken":"a+b/="})),
                Some("a+b/=") => ok(json!({"comments":[{"id":2,"reactions":[{"count":1}]}]})),
                token => panic!("unexpected cursor {token:?}"),
            }
        }));
        let client = AdoClient::new(&ado, "https://dev.azure.com/acme");
        let mut project = None;
        let all = Resource::Wi.sections();
        let snap = client.read_ticket(3, &all, &mut project).unwrap().snapshot(&client.org_url, &all);
        assert_eq!(snap["details"]["fields"]["Custom.Field"], "abc");
        assert_eq!(snap["details"]["revision"], 2);
        assert_eq!(snap["relations"][0]["workItem"]["state"], "Active");
        assert_eq!(snap["relations"][1]["workItem"]["title"], "Item 5");
        assert!(snap["relations"][2]["workItemId"].is_null());
        assert_eq!(snap["comments"][1]["reactions"][0]["count"], 1);
        let before = ado.requests().len();
        let comments = [Section::Comments].into();
        let only = client.read_ticket(3, &comments, &mut project).unwrap().snapshot(&client.org_url, &comments);
        assert_eq!(only, json!({"comments":snap["comments"]}));
        assert_eq!(ado.requests().len() - before, 2);
    }
}
