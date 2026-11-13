//! One error type. Its kind decides the exit code, so scripts can branch on it,
//! and it crosses the daemon socket and JSON-RPC unchanged.

use serde::{Deserialize, Serialize};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Bad input: missing or contradictory flags, malformed arguments. Exit 1.
    User,
    /// The thing asked about doesn't exist (no PR, no work item, no team). Exit 2.
    NotFound,
    /// Something dova needs is missing: az, access, the daemon. Exit 3.
    Prereq,
    /// az has no usable login. In a terminal dova answers this by running `az login`. Exit 3.
    NotSignedIn,
    /// A git command or Azure DevOps request failed. Exit 4.
    External,
    /// A bug, or something nobody planned for. Exit 5.
    #[serde(other)]
    Unexpected,
}

/// `hints` print under the message: what to run or pass to get past it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Error {
    pub kind: Kind,
    pub message: String,
    #[serde(default)]
    pub hints: Vec<String>,
    /// For `NotSignedIn`: the tenant az has no login for, when it isn't the default one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
}

impl Error {
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        Error { kind, message: message.into(), hints: Vec::new(), tenant: None }
    }

    pub fn user(message: impl Into<String>) -> Self {
        Self::new(Kind::User, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(Kind::NotFound, message)
    }

    pub fn prereq(message: impl Into<String>) -> Self {
        Self::new(Kind::Prereq, message)
    }

    pub fn external(message: impl Into<String>) -> Self {
        Self::new(Kind::External, message)
    }

    pub fn unexpected(message: impl Into<String>) -> Self {
        Self::new(Kind::Unexpected, message)
    }

    pub fn not_signed_in(message: impl Into<String>, tenant: Option<&str>) -> Self {
        let login = match tenant {
            Some(t) => format!("Run: az login --tenant {t}"),
            None => "Run: az login".to_string(),
        };
        Error { tenant: tenant.map(str::to_string), ..Self::new(Kind::NotSignedIn, message).hint(login) }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hints.push(hint.into());
        self
    }

    pub fn exit_code(&self) -> i32 {
        match self.kind {
            Kind::User => 1,
            Kind::NotFound => 2,
            Kind::Prereq | Kind::NotSignedIn => 3,
            Kind::External => 4,
            Kind::Unexpected => 5,
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::unexpected(err.to_string())
    }
}
