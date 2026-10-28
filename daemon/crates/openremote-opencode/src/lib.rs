//! OpenCode harness driver.
//!
//! OpenCode is an HTTP service, not a stdio protocol: the driver spawns
//! `opencode serve --port 0` per session (basic auth via
//! `OPENCODE_SERVER_PASSWORD`, username `opencode` - verified live
//! against opencode 1.18.21 and, for the desktop install, 2.1.2), creates
//! the session with `POST /api/session`, prompts with `POST …/prompt`,
//! and consumes `GET /api/event`. v1 frames events as `properties` and
//! ends a turn on `session.next.step.ended`; v2 frames them as `data`
//! and ends a turn on `session.step.ended` / `session.execution.*`.
//! Permissions and questions are answered with OpenCode's own words
//! (`once | always | reject`; question answers as selected labels).

pub mod catalog;
pub mod commands;
pub mod driver;
pub mod http;
pub mod listen;
pub mod resolve;

use std::path::Path;

pub use catalog::models;
pub use commands::commands;
pub use driver::Driver;
pub use openremote_harness::{DriverError, DriverEvent, Resolution, SpawnOptions};

/// Find the opencode CLI. `override` wins (tests point it at the
/// fixture); otherwise `opencode` on PATH.
pub fn resolve_opencode(override_path: Option<&Path>) -> Resolution {
    resolve::resolve_impl(override_path.map(std::path::PathBuf::from))
}
