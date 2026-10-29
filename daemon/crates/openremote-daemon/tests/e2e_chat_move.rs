//! Moving a chat between projects: the route the sidebar's row calls. A move
//! lands the chat in the new folder and the old one no longer lists it; an
//! unknown project is refused with a reason; a chat with a turn in flight is
//! refused with the daemon's words.

mod common;

use std::path::Path;

use common::{TestDaemon, call, fixture_agent, start_daemon, until_status, workspace};
use serde_json::json;

/// One project, registered on this daemon, by folder.
async fn project(daemon: &TestDaemon, request: &str, folder: &Path) -> String {
    let made = call(
        daemon,
        "POST",
        "/projects",
        Some(json!({"request_id": request, "folders": [folder]})),
    )
    .await;
    assert_eq!(made.status, 201, "raw: {}", made.raw);
    made.body["id"].as_str().expect("a project id").to_string()
}

/// A chat running in `folder`.
async fn session_in(daemon: &TestDaemon, request: &str, folder: &Path) -> String {
    let made = call(
        daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": request, "harness": "claude", "workspace": folder})),
    )
    .await;
    assert_eq!(made.status, 201, "raw: {}", made.raw);
    made.body["id"].as_str().expect("a session id").to_string()
}

fn folder_of(session: &serde_json::Value) -> String {
    session["workspace"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn a_move_lands_the_chat_in_the_new_project() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let from = workspace(Some("plain"));
    let to = workspace(Some("plain"));
    let id = session_in(&daemon, "r-create", from.path()).await;
    until_status(&daemon, &id, &["idle"]).await;
    let project = project(&daemon, "r-project", to.path()).await;

    let moved = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/workspace"),
        Some(json!({"request_id": "r-move", "project_id": project})),
    )
    .await;
    assert_eq!(moved.status, 200, "raw: {}", moved.raw);
    assert_eq!(
        folder_of(&moved.body["result"]),
        to.path().to_string_lossy(),
        "the route answers with the chat in its new folder"
    );

    // The project a chat is in is its folder, so the old project no longer
    // lists it: the poll agrees with the route's answer.
    let listed = call(&daemon, "GET", "/sessions", None).await;
    let row = listed
        .body
        .as_array()
        .and_then(|all| all.iter().find(|s| s["id"] == id.as_str()))
        .cloned()
        .expect("the chat is still listed");
    assert_eq!(folder_of(&row), to.path().to_string_lossy());

    // The harness restarted in the new folder and settles there.
    until_status(&daemon, &id, &["idle"]).await;
}

#[tokio::test]
async fn a_move_to_an_unknown_project_is_refused_with_a_reason() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let here = workspace(Some("plain"));
    let id = session_in(&daemon, "r-create", here.path()).await;
    let refused = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/workspace"),
        Some(json!({
            "request_id": "r-move",
            "project_id": "00000000-0000-0000-0000-000000000000"
        })),
    )
    .await;
    assert_eq!(refused.status, 404, "raw: {}", refused.raw);
    assert!(
        refused.body["error"]
            .as_str()
            .is_some_and(|error| error.contains("isn't registered on this machine")),
        "raw: {}",
        refused.raw
    );
}

#[tokio::test]
async fn a_move_during_a_turn_is_refused_with_the_daemons_words() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let busy = workspace(Some("hold"));
    let other = workspace(Some("plain"));
    let id = session_in(&daemon, "r-create", busy.path()).await;
    until_status(&daemon, &id, &["idle"]).await;
    let project = project(&daemon, "r-project", other.path()).await;

    let prompt = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "r-prompt", "text": "do the thing"})),
    )
    .await;
    assert_eq!(prompt.status, 200, "raw: {}", prompt.raw);
    until_status(&daemon, &id, &["working"]).await;

    let refused = call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/workspace"),
        Some(json!({"request_id": "r-move", "project_id": project})),
    )
    .await;
    assert_eq!(refused.status, 409, "raw: {}", refused.raw);
    assert!(
        refused.body["error"]
            .as_str()
            .is_some_and(|error| error.contains("a turn is running in this chat")),
        "raw: {}",
        refused.raw
    );
}
