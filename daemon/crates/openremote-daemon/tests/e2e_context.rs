//! Context accounting e2e: the harness's own numbers ride to the console
//! (claude's result usage, codex's tokenUsage with the model's window),
//! and the compaction marker lands as the transcript's own note.

mod common;

use common::*;
use serde_json::json;

#[tokio::test]
async fn claude_reports_its_turns_context() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("plain"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "c-create", "harness": "claude", "workspace": ws.path()})),
    )
    .await;
    let id = created.body["id"].as_str().expect("session id").to_string();
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "c-p", "text": "hello fixture"})),
    )
    .await;
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["turn.completed", "session.status_changed"],
    )
    .await;
    let used = events
        .iter()
        .find(|(_, p)| kind(p) == "context.used")
        .expect("claude's own usage rides the turn");
    // The fixture's result usage: 10 input tokens, no cache fields.
    assert_eq!(used.1["used"], json!(10));
    assert!(
        used.1.get("window").is_none(),
        "claude's stream-json carries no window; events:\n{}",
        dump(&events)
    );

    // The turn's cost, verbatim from the fixture's result frame.
    let cost = events
        .iter()
        .find(|(_, p)| kind(p) == "usage.cost")
        .expect("claude's own cost rides the turn");
    assert_eq!(cost.1["cost_usd"], json!(0.042));
}

#[tokio::test]
async fn claude_compaction_lands_as_the_transcripts_note() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("compact"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "c-create", "harness": "claude", "workspace": ws.path()})),
    )
    .await;
    let id = created.body["id"].as_str().expect("session id").to_string();
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "c-p", "text": "hello fixture"})),
    )
    .await;
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["turn.completed", "session.status_changed"],
    )
    .await;
    let note = events
        .iter()
        .find(|(_, p)| kind(p) == "note.added")
        .expect("the compaction marker becomes a note");
    assert_eq!(
        note.1["text"],
        json!("This session was compacted before this message."),
        "events:\n{}",
        dump(&events)
    );
    // The compacted turn's context: 40 input + 12000 cache-read + 260
    // cache-write - the SDK's own context math.
    let used = events
        .iter()
        .find(|(_, p)| kind(p) == "context.used")
        .expect("usage after compaction");
    assert_eq!(used.1["used"], json!(12300));
}

#[tokio::test]
async fn codex_reports_context_against_the_models_window() {
    let daemon = start_daemon(&[("claude", fixture_agent()), ("codex", fixture_agent())]).await;
    let ws = workspace(Some("plain"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "x-create", "harness": "codex", "workspace": ws.path()})),
    )
    .await;
    let id = created.body["id"].as_str().expect("session id").to_string();
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "x-p", "text": "run the thing"})),
    )
    .await;
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["turn.completed", "session.status_changed"],
    )
    .await;
    let used = events
        .iter()
        .find(|(_, p)| kind(p) == "context.used")
        .expect("codex's tokenUsage rides the turn");
    assert_eq!(used.1["used"], json!(1250));
    assert_eq!(used.1["window"], json!(200000));
}

#[tokio::test]
async fn codex_compaction_lands_as_the_transcripts_note() {
    let daemon = start_daemon(&[("claude", fixture_agent()), ("codex", fixture_agent())]).await;
    let ws = workspace(Some("compact"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "x-create", "harness": "codex", "workspace": ws.path()})),
    )
    .await;
    let id = created.body["id"].as_str().expect("session id").to_string();
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "x-p", "text": "run the thing"})),
    )
    .await;
    let events = until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["turn.completed", "session.status_changed"],
    )
    .await;
    let note = events
        .iter()
        .find(|(_, p)| kind(p) == "note.added")
        .expect("the compaction marker becomes a note");
    assert_eq!(
        note.1["text"],
        json!("This session was compacted before this message."),
        "events:\n{}",
        dump(&events)
    );
}

#[tokio::test]
async fn claude_shares_its_reasoning_and_thinking_tokens() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("think"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "t-create", "harness": "claude", "workspace": ws.path()})),
    )
    .await;
    let id = created.body["id"].as_str().expect("session id").to_string();
    until_kinds(
        &daemon,
        &format!("/sessions/{id}/events"),
        &["session.status_changed"],
    )
    .await;
    call(
        &daemon,
        "POST",
        &format!("/sessions/{id}/prompts"),
        Some(json!({"request_id": "t-p", "text": "what is 17*23"})),
    )
    .await;

    let events = until_count(
        &daemon,
        &format!("/sessions/{id}/events"),
        "turn.completed",
        1,
    )
    .await;
    // The reasoning stream grew, and the settled thinking block replaced it.
    let deltas: Vec<&str> = events
        .iter()
        .filter(|(_, p)| kind(p) == "reasoning.delta")
        .filter_map(|(_, p)| p["text"].as_str())
        .collect();
    assert_eq!(
        deltas,
        vec!["Let me compute ", "17*23 ", "step by step."],
        "thinking deltas stream in order; events:\n{}",
        dump(&events)
    );
    let settled = events
        .iter()
        .find(|(_, p)| kind(p) == "reasoning.added")
        .expect("the thinking block lands as reasoning.added");
    assert_eq!(
        settled.1["text"], "Let me compute 17*23 step by step.",
        "the harness's own thinking, verbatim"
    );
    // The reply itself stays unmixed.
    let reply = events
        .iter()
        .find(|(_, p)| kind(p) == "message.added" && p["message"]["role"] == "assistant")
        .expect("assistant reply");
    assert_eq!(reply.1["message"]["text"], "done: what is 17*23");
    // The turn's thinking tokens, the SDK's own field, verbatim.
    let thinking = events
        .iter()
        .find(|(_, p)| kind(p) == "thinking.tokens")
        .expect("thinking tokens ride the turn");
    assert_eq!(thinking.1["tokens"], json!(42));
}

/// The usage events name the turn they belong to, filled from the live path.
///
/// A console reader replaces a turn's tally when the same turn is re-reported,
/// which is only true while the daemon stamps the turn: `None` is an older
/// daemon that did not say and would be added instead, while `Some(0)` is the
/// first turn and is real. This drives two real turns through the fixture and
/// asserts what the console receives: both of a turn's totals carry `Some`, the
/// same turn as each other and as the turn the transcript's own delta carried,
/// and the second turn is a different one. The fixture reports usage once per
/// prompt, so a same-turn re-report is not producible here; the stamp is what
/// this proves.
#[tokio::test]
async fn the_usage_events_of_a_turn_carry_its_turn() {
    let daemon = start_daemon(&[("claude", fixture_agent())]).await;
    let ws = workspace(Some("think"));
    let created = call(
        &daemon,
        "POST",
        "/sessions",
        Some(json!({"request_id": "t-create", "harness": "claude", "workspace": ws.path()})),
    )
    .await;
    let id = created.body["id"].as_str().expect("session id").to_string();
    let path = format!("/sessions/{id}/events");
    until_kinds(&daemon, &path, &["session.status_changed"]).await;
    for (request, text) in [("t-p1", "first turn"), ("t-p2", "second turn")] {
        call(
            &daemon,
            "POST",
            &format!("/sessions/{id}/prompts"),
            Some(json!({"request_id": request, "text": text})),
        )
        .await;
    }
    let events = until_count(&daemon, &path, "turn.completed", 2).await;

    let turns_of = |name: &str| -> Vec<Option<u64>> {
        events
            .iter()
            .filter(|(_, p)| kind(p) == name)
            .map(|(_, p)| p["turn"].as_u64())
            .collect()
    };
    let cost = turns_of("usage.cost");
    let thinking = turns_of("thinking.tokens");
    assert_eq!(
        cost.len(),
        2,
        "one cost event per turn; events:\n{}",
        dump(&events)
    );
    assert_eq!(
        thinking.len(),
        2,
        "one thinking event per turn; events:\n{}",
        dump(&events)
    );
    // `None` is an older daemon that did not say; the live path must say.
    assert!(
        cost.iter()
            .chain(thinking.iter())
            .all(|turn| turn.is_some()),
        "the live path stamps a turn: cost {:?}, thinking {:?}; events:\n{}",
        cost,
        thinking,
        dump(&events)
    );
    assert_eq!(cost, thinking, "a turn's two totals name the same turn");
    // The daemon's first turn is 0, which is why the wire field is optional
    // rather than reserving a number for "not said".
    assert_eq!(
        cost[0],
        Some(0),
        "the first turn is Some(0); events:\n{}",
        dump(&events)
    );
    assert_ne!(
        cost[0],
        cost[1],
        "the second turn is a different turn; events:\n{}",
        dump(&events)
    );
    // And the stamp is the turn the transcript's own events carried, so it is
    // the live turn and not a placeholder.
    let delta_turn = events
        .iter()
        .find(|(_, p)| kind(p) == "reasoning.delta")
        .and_then(|(_, p)| p["turn"].as_u64());
    assert_eq!(cost[0], delta_turn);
}
