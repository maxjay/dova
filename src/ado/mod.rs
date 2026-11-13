//! Azure DevOps. A request and its response are plain data, so they cross
//! the daemon socket unchanged; `AdoClient` is the only thing that builds
//! them, and a `Transport` is whoever holds the credentials to send them.

pub mod auth;
pub mod client;
pub mod map;
pub mod types;

use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Patch,
    Put,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Patch => "PATCH",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
        }
    }

    pub fn parse(name: &str) -> Option<Method> {
        [Method::Get, Method::Post, Method::Patch, Method::Put, Method::Delete]
            .into_iter()
            .find(|m| m.as_str().eq_ignore_ascii_case(name))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub method: Method,
    /// Absolute https URL on dev.azure.com or *.visualstudio.com.
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// Ask for plain text back (a build log) instead of JSON.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub text: bool,
}

impl Request {
    pub fn get(url: impl Into<String>) -> Request {
        Request { method: Method::Get, url: url.into(), body: None, content_type: None, text: false }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

/// Who az is signed in as, or why nobody is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub account: Option<String>,
    pub tenant: Option<String>,
    pub expires_at: Option<String>,
    pub error: Option<String>,
}

/// Sends requests signed as the user: the daemon, or this process.
pub trait Transport: Send + Sync {
    /// `daemon` or `in-process`.
    fn kind(&self) -> &'static str;
    fn send(&self, req: &Request) -> Result<Response>;
    fn auth_status(&self) -> Result<AuthStatus>;
}
