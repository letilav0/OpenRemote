//! Two of an account's devices share the browser's settings and bookmarks.
//! A setting written on one appears on the other; a bookmark deleted on one
//! does not come back from the other's older state.
//!
//! What is deliberately not here: history, cookies, site storage and the tabs
//! to restore. Those never leave the device that made them, so there is
//! nothing to test across the link.

mod common;

use std::time::Duration;

use common::{TestDaemon, call, raw_http, start_cloud_daemon};
use fake_cloud::FakeCloud;
use openremote_cloud::CloudConfig;
use openremote_cloud::https::Http;
use serde_json::{Value, json};

fn config(cloud: &FakeCloud, name: &str) -> CloudConfig {
    CloudConfig {
        api_base: cloud.api(),
        auth_issuer: cloud.issuer(),
        client_id: openremote_cloud::config::CLIENT_ID.into(),
        device_name: name.into(),
        platform: std::env::consts::OS.into(),
        redirect_uri: None,
    }
}

async fn sign_in(daemon: &TestDaemon) -> String {
    let started = call(daemon, "POST", "/cloud/signin", None).await;
    let url = started.body["authorize_url"].as_str().unwrap().to_string();
    let page = Http::new().request("GET", &url, &[], None).await.unwrap();
    let location = page.headers["location"].to_str().unwrap().to_string();
    let (_, rest) = location.split_once("/cloud/callback").unwrap();
    let landed = raw_http(daemon, "GET", &format!("/cloud/callback{rest}"), &[], None).await;
    assert_eq!(landed.status, 200, "{}", landed.raw);
    call(daemon, "GET", "/cloud", None).await.body["device"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Polls `check` for up to half a minute: a note travels through the relay,
/// so the far side is a little behind by design.
async fn until<T, F, Fut>(what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    for _ in 0..300 {
        if let Some(v) = check().await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn browser_state(daemon: &TestDaemon) -> Value {
    call(daemon, "GET", "/browser", None).await.body
}

#[tokio::test]
async fn a_setting_and_a_bookmark_deletion_travel_between_two_devices() {
    let cloud = FakeCloud::start().await;
    let a = start_cloud_daemon(&[], Some(config(&cloud, "desk-a"))).await;
    let b = start_cloud_daemon(&[], Some(config(&cloud, "desk-b"))).await;
    let _id_a = sign_in(&a).await;
    let _id_b = sign_in(&b).await;

    // A setting changed on A reaches B.
    let written = call(
        &a,
        "POST",
        "/browser/settings",
        Some(serde_json::json!({"search": "duckduckgo"})),
    )
    .await;
    assert_eq!(written.status, 200, "{}", written.raw);
    let on_b = until("B to adopt A's search setting", || async {
        let state = browser_state(&b).await;
        (state["settings"]["search"] == "duckduckgo").then_some(())
    })
    .await;
    assert_eq!(on_b, (), "B shows what A wrote");

    // A bookmark saved on A reaches B with the same id, so the deletion the
    // next step makes can name it on both.
    let saved = call(
        &a,
        "POST",
        "/browser/bookmarks",
        Some(
            serde_json::json!({"url": "https://example.com/", "title": "Example", "folder": "bar"}),
        ),
    )
    .await;
    assert_eq!(saved.status, 200, "{}", saved.raw);
    let id = saved.body["id"].as_str().unwrap().to_string();
    until("B to adopt A's bookmark", || async {
        let state = browser_state(&b).await;
        state["bookmarks"]
            .as_array()
            .is_some_and(|marks| marks.iter().any(|mark| mark["id"] == id))
            .then_some(())
    })
    .await;

    // Deleting it on A removes it on B, and B's older state does not bring it
    // back: after the tombstone has landed, B stays without it.
    let removed = call(
        &a,
        "POST",
        &format!("/browser/bookmarks/{id}/remove"),
        Some(json!({"request_id": "r-remove-old"})),
    )
    .await;
    assert_eq!(removed.status, 200, "{}", removed.raw);
    until("B to lose the deleted bookmark", || async {
        let state = browser_state(&b).await;
        state["bookmarks"]
            .as_array()
            .is_some_and(|marks| marks.iter().all(|mark| mark["id"] != id))
            .then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let later = browser_state(&b).await;
    assert!(
        later["bookmarks"]
            .as_array()
            .is_some_and(|marks| marks.iter().all(|mark| mark["id"] != id)),
        "a deleted bookmark stays deleted: {}",
        later["bookmarks"]
    );
    let on_a = browser_state(&a).await;
    assert!(
        on_a["bookmarks"]
            .as_array()
            .is_some_and(|marks| marks.iter().all(|mark| mark["id"] != id)),
        "and it is gone where it was deleted"
    );
}

/// A bookmark written through the console's own route is read back there, and
/// a delete takes it out of the list (the store keeps the tombstone, which is
/// what the merge hon ours: browser/sync.rs pins that half).
#[tokio::test]
async fn a_bookmark_written_through_the_route_is_read_and_deleted_there() {
    let daemon = common::start_daemon(&[]).await;
    let saved = call(
        &daemon,
        "POST",
        "/browser/bookmarks",
        Some(json!({"request_id": "r-save", "url": "https://example.com/", "title": "Example"})),
    )
    .await;
    assert_eq!(saved.status, 200, "raw: {}", saved.raw);
    let id = saved.body["result"]["bookmark"]["id"]
        .as_str()
        .expect("a bookmark id")
        .to_string();
    let listed = call(&daemon, "GET", "/browser/bookmarks", None).await;
    assert!(
        listed.body["bookmarks"]
            .as_array()
            .is_some_and(|all| all.iter().any(|m| m["id"] == id.as_str())),
        "raw: {}",
        listed.raw
    );
    let removed = call(
        &daemon,
        "POST",
        &format!("/browser/bookmarks/{id}/remove"),
        Some(json!({"request_id": "r-remove"})),
    )
    .await;
    assert_eq!(removed.status, 200, "raw: {}", removed.raw);
    let after = call(&daemon, "GET", "/browser/bookmarks", None).await;
    assert!(
        after.body["bookmarks"]
            .as_array()
            .is_some_and(|all| all.iter().all(|m| m["id"] != id.as_str())),
        "raw: {}",
        after.raw
    );
}

/// The console's route is the path a person's bookmark takes: saved on A, it
/// arrives on B through the note, and deleting it on A removes it on B.
#[tokio::test]
async fn a_bookmark_saved_through_the_route_reaches_the_other_device() {
    let cloud = FakeCloud::start().await;
    let a = start_cloud_daemon(&[], Some(config(&cloud, "desk-a"))).await;
    let b = start_cloud_daemon(&[], Some(config(&cloud, "desk-b"))).await;
    let _id_a = sign_in(&a).await;
    let _id_b = sign_in(&b).await;

    let saved = call(
        &a,
        "POST",
        "/browser/bookmarks",
        Some(json!({"request_id": "r-save", "url": "https://example.com/", "title": "Example"})),
    )
    .await;
    assert_eq!(saved.status, 200, "raw: {}", saved.raw);
    let id = saved.body["result"]["bookmark"]["id"]
        .as_str()
        .expect("a bookmark id")
        .to_string();
    until("B to show the bookmark saved on A", || async {
        let listed = call(&b, "GET", "/browser/bookmarks", None).await;
        listed.body["bookmarks"]
            .as_array()
            .is_some_and(|all| all.iter().any(|m| m["id"] == id.as_str()))
            .then_some(())
    })
    .await;

    let removed = call(
        &a,
        "POST",
        &format!("/browser/bookmarks/{id}/remove"),
        Some(json!({"request_id": "r-remove"})),
    )
    .await;
    assert_eq!(removed.status, 200, "raw: {}", removed.raw);
    until("B to lose the deleted bookmark", || async {
        let listed = call(&b, "GET", "/browser/bookmarks", None).await;
        listed.body["bookmarks"]
            .as_array()
            .is_some_and(|all| all.iter().all(|m| m["id"] != id.as_str()))
            .then_some(())
    })
    .await;
}
