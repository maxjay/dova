use super::{AdoClient, COMMENTS};
use crate::ado::map::to_work_item;
use crate::ado::sections::{Section, Sections};
use crate::error::{Error, Result};
use crate::{par, urls};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

impl AdoClient<'_> {
    pub fn ticket(&self, id: u64, relations: bool) -> Result<Value> {
        let expand = if relations { "relations" } else { "none" };
        self.get(&format!("_apis/wit/workitems/{id}"), &[("$expand", expand)]).map_err(|err| {
            if err.kind == crate::error::Kind::NotFound {
                Error::not_found(format!("Work item #{id} was not found."))
            } else {
                err
            }
        })
    }

    /// Azure returns the project on the item itself. Keep it for comments-only
    /// reads, and replace it on each item read (an item can move projects).
    pub fn ticket_sections(&self, id: u64, sections: &Sections, project: &mut Option<String>) -> Result<Value> {
        use Section::*;
        let mut result = json!({});
        let mut relations = Vec::new();
        let mut comment_count = None;
        if sections.contains(&Details) || sections.contains(&Relations) || project.is_none() {
            let mut raw = self.ticket(id, sections.contains(&Relations))?;
            let project_name = raw["fields"]["System.TeamProject"]
                .as_str()
                .ok_or_else(|| Error::external("Missing project on the Azure work item."))?;
            if raw["id"].as_u64() != Some(id) || raw["rev"].as_u64().is_none() {
                return Err(Error::external("Invalid work item returned by Azure DevOps."));
            }
            *project = Some(project_name.to_owned());
            comment_count = raw["fields"]["System.CommentCount"].as_u64();
            if sections.contains(&Details) {
                let mut details = json!(to_work_item(&raw, &self.org_url));
                details["revision"] = raw["rev"].take();
                details["fields"] = raw["fields"].take();
                result["details"] = details;
            }
            if let Some(value) = raw.get_mut("relations").filter(|v| !v.is_null()) {
                relations = serde_json::from_value(value.take())
                    .map_err(|_| Error::external("Invalid work item relations."))?;
            }
        }
        let project = project.as_deref().ok_or_else(|| Error::external("Missing work item project."))?;
        let (links, comments) = par::join(
            || self.ticket_relations(relations),
            || {
                if sections.contains(&Comments) && comment_count != Some(0) {
                    self.ticket_comments(project, id)
                } else {
                    Ok(Vec::new())
                }
            },
        );
        if sections.contains(&Relations) {
            result["relations"] = json!(links?);
        }
        if sections.contains(&Comments) {
            result["comments"] = json!(comments?);
        }
        Ok(result)
    }

    fn ticket_relations(&self, mut relations: Vec<Value>) -> Result<Vec<Value>> {
        let ids: Vec<_> = relations
            .iter()
            .map(|r| {
                if matches!(r["rel"].as_str(), Some("Hyperlink" | "ArtifactLink" | "AttachedFile")) {
                    return None;
                }
                urls::linked_work_item(&self.org_url, r["url"].as_str()?)
            })
            .collect();
        let tickets = self.work_item_refs(&ids.iter().flatten().copied().collect::<Vec<_>>())?;
        let by_id: HashMap<_, _> = tickets.into_iter().map(|w| (w.id, w)).collect();
        for (link, id) in relations.iter_mut().zip(ids) {
            if let Some(id) = id {
                link["workItemId"] = json!(id);
                link["workItem"] = json!(by_id.get(&id));
            }
        }
        Ok(relations)
    }

    pub(super) fn ticket_comments(&self, project: &str, id: u64) -> Result<Vec<Value>> {
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
        let snap = client.ticket_sections(3, &Resource::Wi.sections(), &mut project).unwrap();
        assert_eq!(snap["details"]["fields"]["Custom.Field"], "abc");
        assert_eq!(snap["details"]["revision"], 2);
        assert_eq!(snap["relations"][0]["workItem"]["state"], "Active");
        assert_eq!(snap["relations"][1]["workItem"]["title"], "Item 5");
        assert!(snap["relations"][2]["workItemId"].is_null());
        assert_eq!(snap["comments"][1]["reactions"][0]["count"], 1);
        let before = ado.requests().len();
        let only = client.ticket_sections(3, &[Section::Comments].into(), &mut project).unwrap();
        assert_eq!(only, json!({"comments":snap["comments"]}));
        assert_eq!(ado.requests().len() - before, 2);
    }
}
