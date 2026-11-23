use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Section {
    Details,
    Reviewers,
    Discussion,
    Checks,
    Statuses,
    Labels,
    WorkItems,
    Files,
    Relations,
    Comments,
}
pub type Sections = BTreeSet<Section>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Resource {
    Pr,
    Wi,
}

impl Resource {
    pub fn sections(self) -> Sections {
        use Section::*;
        match self {
            Self::Pr => [Details, Reviewers, Discussion, Checks, Statuses, Labels, WorkItems, Files].into(),
            Self::Wi => [Details, Relations, Comments].into(),
        }
    }

    pub fn prefix(self) -> &'static str {
        match self {
            Self::Pr => "pr",
            Self::Wi => "wi",
        }
    }

    pub fn hub(self) -> &'static str {
        match self {
            Self::Pr => "pullrequestdetailhub",
            Self::Wi => "workitemhub",
        }
    }
}
