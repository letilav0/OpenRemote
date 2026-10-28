//! The daemon's browser calls, run on this window's tabs: what agents do
//! through their browser tools. A page is read and nudged through the page
//! helper (`openremote_browser::AGENT_SCRIPT`) in an isolated world of its
//! own, so the page can neither see nor break it, and acted on with real
//! input (clicks, keys, wheel) through the DevTools protocol, in process:
//! no debugging port is ever opened.
//!
//! Opening, closing and moving between pages works on every desktop; reading
//! and acting inside pages needs WebView2's DevTools protocol, so on macOS and
//! Linux those calls say so for now.

use openremote_browser::{Call, Controller, TabInfo};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};

use super::Browser;

/// Every call the daemon makes.
pub async fn run(app: &AppHandle, call: Call) -> Result<Value, String> {
    if let Some(done) = super::pipe::bookkeeping(app, &call) {
        return done;
    }
    match call {
        Call::Open { url, controller } => open(app, &url, controller).await,
        Call::Close { tab } => {
            super::close_tab(app, &tab)?;
            Ok(Value::Null)
        }
        // Agents switching tabs never move the user's view.
        Call::Select { .. } => Ok(Value::Null),
        Call::Navigate { tab, url } => {
            let url = parse_url(&url)?;
            if !super::allowed(&url, app.config().build.dev_url.as_ref()) {
                return Err(format!("{url} can't be opened in the browser"));
            }
            super::tab(app, &tab)?
                .navigate(url)
                .map_err(|e| e.to_string())?;
            settle(app, &tab, true).await;
            Ok(page_answer(app, &tab, json!({})))
        }
        Call::Back { tab } => go(app, &tab, -1).await,
        Call::Forward { tab } => go(app, &tab, 1).await,
        Call::Reload { tab } => {
            super::tab(app, &tab)?.reload().map_err(|e| e.to_string())?;
            settle(app, &tab, true).await;
            Ok(page_answer(app, &tab, json!({})))
        }
        other => in_page(app, other).await,
    }
}

/// Back (-1) or forward (1) in a tab's own history.
async fn go(app: &AppHandle, tab: &str, step: i32) -> Result<Value, String> {
    super::history(&super::tab(app, tab)?, step)?;
    settle(app, tab, true).await;
    Ok(page_answer(app, tab, json!({})))
}

/// An address as agents write it: with or without its scheme.
fn parse_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    Url::parse(raw)
        .or_else(|_| Url::parse(&format!("https://{raw}")))
        .map_err(|_| format!("'{raw}' is not an address"))
}

/// The tab's address and title after a call, with the call's own news.
fn page_answer(app: &AppHandle, tab: &str, mut extra: Value) -> Value {
    let (url, title) = app
        .state::<Browser>()
        .tabs
        .lock()
        .expect("browser lock")
        .get(tab)
        .map(|t| (t.url.clone(), t.title.clone()))
        .unwrap_or_default();
    extra["url"] = json!(url);
    extra["title"] = json!(title);
    extra
}

fn loading(app: &AppHandle, tab: &str) -> Option<bool> {
    app.state::<Browser>()
        .tabs
        .lock()
        .expect("browser lock")
        .get(tab)
        .map(|t| t.loading)
}

/// Wait for what an action set off: a page that started loading gets up to
/// 15 seconds to finish. `expect_load` waits a moment longer for the load
/// to start (a navigation the call itself began).
async fn settle(app: &AppHandle, tab: &str, expect_load: bool) {
    let start = std::time::Instant::now();
    let grace = if expect_load { 600 } else { 150 };
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let mut seen_loading = false;
    while start.elapsed() < std::time::Duration::from_secs(15) {
        match loading(app, tab) {
            Some(true) => seen_loading = true,
            Some(false) if seen_loading || start.elapsed().as_millis() > grace => break,
            None => break,
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// A tab an agent opens: drawn off screen (so it renders and can be
/// pictured) until the console shows it, marked with the chat from the start.
async fn open(app: &AppHandle, url: &str, controller: Option<Controller>) -> Result<Value, String> {
    let url = parse_url(url)?;
    let bounds = super::parked_bounds(app);
    let opener = app.clone();
    let id = tauri::async_runtime::spawn_blocking(move || {
        super::open_tab(opener, url, bounds, true, None, false)
    })
    .await
    .map_err(|e| e.to_string())??;
    super::update(app, &id, |t| {
        t.controller = controller;
        t.parked = true;
    });
    settle(app, &id, true).await;
    let browser = app.state::<Browser>();
    let tab = browser
        .tabs
        .lock()
        .expect("browser lock")
        .get(&id)
        .map(super::pipe::info)
        .unwrap_or(TabInfo {
            id: id.clone(),
            ..Default::default()
        });
    Ok(serde_json::to_value(tab).unwrap_or_default())
}

#[cfg(not(windows))]
async fn in_page(_app: &AppHandle, _call: Call) -> Result<Value, String> {
    Err("Reading and acting inside pages needs the Windows browser for now: on this computer agents can open, close and move between pages.".into())
}

#[cfg(windows)]
use page::in_page;

#[cfg(windows)]
pub use page::{forget, pick, screencast};

/// Reading and acting inside pages, through WebView2's DevTools protocol.
#[cfg(windows)]
mod page {
    use std::collections::{HashMap, VecDeque};
    use std::sync::Mutex;
    use std::time::Duration;

    use openremote_browser::{keys, Call, AGENT_SCRIPT};
    use serde_json::{json, Value};
    use tauri::{AppHandle, Emitter, Manager, Webview};

    use super::super::{win, Browser};
    use super::{page_answer, settle};

    /// The isolated world's name in every page.
    const WORLD: &str = "openremote";
    /// The binding the element picker answers through.
    const PICKED: &str = "__openremotePick";
    /// Console and network lines kept per tab until an agent reads them.
    const KEPT: usize = 300;

    /// What the shell keeps about a page agents use.
    #[derive(Default)]
    struct Page {
        /// The helper's world in the current document, once made.
        world: Option<i64>,
        instrumented: bool,
        picker_bound: bool,
        console: VecDeque<String>,
        network: VecDeque<String>,
        requests: HashMap<String, (String, String, String)>,
        /// An alert, confirm or prompt waiting for an answer: (kind, text).
        dialog: Option<(String, String)>,
        /// A file picker the page opened while we were listening for one.
        chooser: Option<i64>,
    }

    static PAGES: Mutex<Option<HashMap<String, Page>>> = Mutex::new(None);

    fn with_page<R>(tab: &str, f: impl FnOnce(&mut Page) -> R) -> R {
        let mut pages = PAGES.lock().unwrap_or_else(|e| e.into_inner());
        f(pages
            .get_or_insert_with(HashMap::new)
            .entry(tab.to_string())
            .or_default())
    }

    /// A closed tab's page record goes with it.
    pub fn forget(tab: &str) {
        let mut pages = PAGES.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pages) = pages.as_mut() {
            pages.remove(tab);
        }
    }

    fn keep(lines: &mut VecDeque<String>, line: String) {
        let line = if line.chars().count() > 600 {
            format!("{}…", line.chars().take(599).collect::<String>())
        } else {
            line
        };
        lines.push_back(line);
        while lines.len() > KEPT {
            lines.pop_front();
        }
    }

    /// A JavaScript string literal.
    fn js(text: &str) -> String {
        serde_json::to_string(text).expect("a string serializes")
    }

    /// A console call's arguments as one line of text.
    fn console_text(args: &Value) -> String {
        args.as_array()
            .map(|args| {
                args.iter()
                    .map(|a| {
                        a.get("value")
                            .map(|v| match v {
                                Value::String(s) => s.clone(),
                                other => other.to_string(),
                            })
                            .or_else(|| a["description"].as_str().map(str::to_string))
                            .unwrap_or_else(|| a["type"].as_str().unwrap_or("").to_string())
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    }

    /// Start hearing a page's console, network, dialogs, file pickers,
    /// picks and frames: once per tab, the first time an agent (or the
    /// picker, or a recording) needs them.
    async fn instrument(app: &AppHandle, webview: &Webview) -> Result<(), String> {
        let tab = webview.label().to_string();
        if with_page(&tab, |p| std::mem::replace(&mut p.instrumented, true)) {
            return Ok(());
        }
        let t = tab.clone();
        win::on_event(webview, "Runtime.consoleAPICalled", move |e| {
            let line = format!(
                "[{}] {}",
                e["type"].as_str().unwrap_or("log"),
                console_text(&e["args"])
            );
            with_page(&t, |p| keep(&mut p.console, line));
        })?;
        let t = tab.clone();
        win::on_event(webview, "Runtime.exceptionThrown", move |e| {
            let details = &e["exceptionDetails"];
            let text = details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .unwrap_or("an error");
            with_page(&t, |p| keep(&mut p.console, format!("[error] {text}")));
        })?;
        let t = tab.clone();
        win::on_event(webview, "Log.entryAdded", move |e| {
            let entry = &e["entry"];
            let url = entry["url"].as_str().unwrap_or("");
            let line = format!(
                "[{}] {}{}",
                entry["level"].as_str().unwrap_or("info"),
                entry["text"].as_str().unwrap_or(""),
                if url.is_empty() {
                    String::new()
                } else {
                    format!(" ({url})")
                }
            );
            with_page(&t, |p| keep(&mut p.console, line));
        })?;
        let t = tab.clone();
        win::on_event(webview, "Network.requestWillBeSent", move |e| {
            let url = e["request"]["url"].as_str().unwrap_or("").to_string();
            if url.starts_with("data:") {
                return;
            }
            let entry = (
                e["request"]["method"].as_str().unwrap_or("GET").to_string(),
                url,
                e["type"].as_str().unwrap_or("Other").to_string(),
            );
            let id = e["requestId"].as_str().unwrap_or("").to_string();
            with_page(&t, |p| {
                p.requests.insert(id, entry);
                if p.requests.len() > 2000 {
                    p.requests.clear();
                }
            });
        })?;
        let t = tab.clone();
        win::on_event(webview, "Network.responseReceived", move |e| {
            let id = e["requestId"].as_str().unwrap_or("");
            let status = e["response"]["status"].as_i64().unwrap_or(0);
            with_page(&t, |p| {
                if let Some((method, url, kind)) = p.requests.remove(id) {
                    keep(&mut p.network, format!("{method} {status} {url} ({kind})"));
                }
            });
        })?;
        let t = tab.clone();
        win::on_event(webview, "Network.loadingFailed", move |e| {
            let id = e["requestId"].as_str().unwrap_or("");
            let why = e["errorText"].as_str().unwrap_or("failed").to_string();
            with_page(&t, |p| {
                if let Some((method, url, kind)) = p.requests.remove(id) {
                    keep(
                        &mut p.network,
                        format!("{method} failed {url} ({kind}): {why}"),
                    );
                }
            });
        })?;
        let t = tab.clone();
        win::on_event(webview, "Page.javascriptDialogOpening", move |e| {
            let dialog = (
                e["type"].as_str().unwrap_or("alert").to_string(),
                e["message"].as_str().unwrap_or("").to_string(),
            );
            with_page(&t, |p| p.dialog = Some(dialog));
        })?;
        let t = tab.clone();
        win::on_event(webview, "Page.javascriptDialogClosed", move |_| {
            with_page(&t, |p| p.dialog = None);
        })?;
        let t = tab.clone();
        win::on_event(webview, "Page.fileChooserOpened", move |e| {
            if let Some(node) = e["backendNodeId"].as_i64() {
                with_page(&t, |p| p.chooser = Some(node));
            }
        })?;
        let t = tab.clone();
        win::on_event(webview, "Runtime.executionContextsCleared", move |_| {
            with_page(&t, |p| p.world = None);
        })?;
        let (a, t) = (app.clone(), tab.clone());
        win::on_event(webview, "Runtime.bindingCalled", move |e| {
            if e["name"].as_str() == Some(PICKED) {
                let payload = e["payload"].as_str().unwrap_or("{}").to_string();
                let (a, t) = (a.clone(), t.clone());
                tauri::async_runtime::spawn(async move { picked(&a, &t, &payload).await });
            }
        })?;
        let (a, t) = (app.clone(), tab.clone());
        win::on_event(webview, "Page.screencastFrame", move |e| {
            let _ = a.emit_to(
                super::super::console(),
                "browser:frame",
                json!({
                    "tab": t,
                    "data": e["data"],
                    "width": e["metadata"]["deviceWidth"],
                    "height": e["metadata"]["deviceHeight"],
                }),
            );
            // Acknowledged a beat later: about ten frames a second is
            // plenty for a recording and keeps the page's own work first.
            if let Some(session) = e["sessionId"].as_i64() {
                let (a, t) = (a.clone(), t.clone());
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(90)).await;
                    if let Ok(webview) = super::super::tab(&a, &t) {
                        let _ = win::cdp(
                            &webview,
                            "Page.screencastFrameAck",
                            json!({ "sessionId": session }),
                        )
                        .await;
                    }
                });
            }
        })?;
        for domain in ["Runtime.enable", "Log.enable", "Page.enable"] {
            win::cdp(webview, domain, json!({})).await?;
        }
        win::cdp(
            webview,
            "Network.enable",
            json!({ "maxTotalBufferSize": 0, "maxResourceBufferSize": 0 }),
        )
        .await?;
        Ok(())
    }

    /// The helper's world in the page's current document, made on demand
    /// (a new document needs a new one).
    async fn world(webview: &Webview) -> Result<i64, String> {
        let tab = webview.label().to_string();
        if let Some(id) = with_page(&tab, |p| p.world) {
            return Ok(id);
        }
        let tree = win::cdp(webview, "Page.getFrameTree", json!({})).await?;
        let frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or("the page has no frame yet")?
            .to_string();
        let made = win::cdp(
            webview,
            "Page.createIsolatedWorld",
            json!({ "frameId": frame, "worldName": WORLD, "grantUniveralAccess": false }),
        )
        .await?;
        let id = made["executionContextId"]
            .as_i64()
            .ok_or("the page refused a world for the helper")?;
        let loaded = win::cdp(
            webview,
            "Runtime.evaluate",
            json!({ "expression": AGENT_SCRIPT, "contextId": id }),
        )
        .await?;
        if let Some(error) = exception(&loaded) {
            return Err(format!("the page helper didn't load: {error}"));
        }
        with_page(&tab, |p| p.world = Some(id));
        Ok(id)
    }

    fn exception(answer: &Value) -> Option<String> {
        let details = answer.get("exceptionDetails")?;
        Some(
            details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .unwrap_or("the script failed")
                .lines()
                .next()
                .unwrap_or("")
                .trim_start_matches("Error: ")
                .to_string(),
        )
    }

    /// Run an expression in the helper's world; a document that changed
    /// under us gets a fresh world and one more try.
    async fn eval(webview: &Webview, expression: &str, by_value: bool) -> Result<Value, String> {
        for attempt in 0..2 {
            let context = world(webview).await?;
            match win::cdp(
                webview,
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "contextId": context,
                    "returnByValue": by_value,
                    "awaitPromise": true,
                }),
            )
            .await
            {
                Err(e) if attempt == 0 && e.contains("context") => {
                    with_page(webview.label(), |p| p.world = None);
                }
                Err(e) => return Err(e),
                Ok(answer) => {
                    if let Some(error) = exception(&answer) {
                        return Err(error);
                    }
                    return Ok(if by_value {
                        answer["result"]["value"].clone()
                    } else {
                        answer["result"].clone()
                    });
                }
            }
        }
        Err("the page kept changing; try again".into())
    }

    async fn helper(webview: &Webview, call: &str) -> Result<Value, String> {
        eval(webview, &format!("__openremote.{call}"), true).await
    }

    async fn mouse(
        webview: &Webview,
        kind: &str,
        (x, y): (f64, f64),
        button: &str,
        clicks: u32,
    ) -> Result<(), String> {
        let buttons = match (kind, button) {
            ("mousePressed", "left") => 1,
            ("mousePressed", "right") => 2,
            ("mousePressed", "middle") => 4,
            _ => 0,
        };
        win::cdp(
            webview,
            "Input.dispatchMouseEvent",
            json!({
                "type": kind, "x": x, "y": y, "button": button,
                "buttons": buttons, "clickCount": clicks,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Where to press an element, after outlining it for whoever watches.
    async fn aim(webview: &Webview, target: &str) -> Result<((f64, f64), Option<String>), String> {
        let _ = helper(webview, &format!("outline({})", js(target))).await;
        let point = helper(webview, &format!("point({})", js(target))).await?;
        let x = point["x"].as_f64().ok_or("the element has no place")?;
        let y = point["y"].as_f64().ok_or("the element has no place")?;
        let covered = point["covered"].as_str().map(|by| {
            format!("Note: {target} looked covered by {by}, so the input may have landed on that instead.")
        });
        Ok(((x, y), covered))
    }

    async fn press(webview: &Webview, chord: &str) -> Result<(), String> {
        let press = keys::parse(chord)?;
        for event in press.events() {
            win::cdp(webview, "Input.dispatchKeyEvent", event).await?;
        }
        Ok(())
    }

    /// The tab made ready for an agent: awake, and drawn (off screen when
    /// the console isn't showing it) so pictures and layout are real.
    fn wake(app: &AppHandle, webview: &Webview) {
        let tab = webview.label().to_string();
        let (suspended, park) = {
            let browser = app.state::<Browser>();
            let mut tabs = browser.tabs.lock().expect("browser lock");
            let Some(t) = tabs.get_mut(&tab) else {
                return;
            };
            let suspended = std::mem::replace(&mut t.suspended, false);
            let park = !t.shown && !t.parked;
            if park {
                t.parked = true;
            }
            (suspended, park)
        };
        if suspended {
            let _ = win::resume(webview);
        }
        if park {
            let bounds = super::super::parked_bounds(app);
            let _ = webview.set_bounds(tauri::Rect {
                position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
                size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
            });
            let _ = webview.show();
        }
    }

    pub async fn in_page(app: &AppHandle, call: Call) -> Result<Value, String> {
        let tab = call.tab().ok_or("that call names no tab")?.to_string();
        let webview = super::super::tab(app, &tab)?;
        wake(app, &webview);
        instrument(app, &webview).await?;
        let w = &webview;
        match call {
            Call::Snapshot { .. } => {
                let text = helper(w, "snapshot()").await?;
                Ok(page_answer(app, &tab, json!({ "text": text })))
            }
            Call::Click {
                target,
                double,
                button,
                ..
            } => {
                let (at, covered) = aim(w, &target).await?;
                let button = button.as_deref().unwrap_or("left");
                mouse(w, "mouseMoved", at, "none", 0).await?;
                for clicks in 1..=if double { 2 } else { 1 } {
                    mouse(w, "mousePressed", at, button, clicks).await?;
                    mouse(w, "mouseReleased", at, button, clicks).await?;
                }
                settle(app, &tab, false).await;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": format!("Clicked {target}."), "note": covered }),
                ))
            }
            Call::Hover { target, .. } => {
                let (at, covered) = aim(w, &target).await?;
                mouse(w, "mouseMoved", at, "none", 0).await?;
                tokio::time::sleep(Duration::from_millis(250)).await;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": format!("The pointer is over {target}."), "note": covered }),
                ))
            }
            Call::Type {
                target,
                text,
                clear,
                submit,
                ..
            } => {
                let _ = helper(w, &format!("outline({})", js(&target))).await;
                let field = helper(w, &format!("focusField({}, {clear})", js(&target))).await?;
                if field["editable"] != true {
                    return Err(format!("{target} is not a field you can type into"));
                }
                win::cdp(w, "Input.insertText", json!({ "text": text })).await?;
                if submit {
                    press(w, "Enter").await?;
                }
                settle(app, &tab, submit).await;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": format!("Typed into {target}{}.", if submit { " and pressed Enter" } else { "" }) }),
                ))
            }
            Call::Press { key, .. } => {
                press(w, &key).await?;
                settle(app, &tab, key.eq_ignore_ascii_case("enter")).await;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": format!("Pressed {key}.") }),
                ))
            }
            Call::SelectOption { target, values, .. } => {
                let _ = helper(w, &format!("outline({})", js(&target))).await;
                let values = serde_json::to_string(&values).unwrap_or_default();
                let chosen =
                    helper(w, &format!("selectOptions({}, {values})", js(&target))).await?;
                let chosen: Vec<String> = chosen
                    .as_array()
                    .map(|c| {
                        c.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                settle(app, &tab, false).await;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": format!("Chose {} in {target}.", chosen.join(", ")) }),
                ))
            }
            Call::Scroll { target, dx, dy, .. } => {
                let at = match &target {
                    Some(target) => aim(w, target).await?.0,
                    None => {
                        let page = helper(w, "page()").await?;
                        (
                            page["viewport"]["width"].as_f64().unwrap_or(800.0) / 2.0,
                            page["viewport"]["height"].as_f64().unwrap_or(600.0) / 2.0,
                        )
                    }
                };
                win::cdp(
                    w,
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseWheel", "x": at.0, "y": at.1, "deltaX": dx, "deltaY": dy }),
                )
                .await?;
                tokio::time::sleep(Duration::from_millis(300)).await;
                let page = helper(w, "page()").await?;
                let text = format!(
                    "Scrolled. The view is at {} of {} pixels down.",
                    page["scroll"]["y"].as_f64().unwrap_or(0.0).round(),
                    page["height"].as_f64().unwrap_or(0.0).round()
                );
                Ok(page_answer(app, &tab, json!({ "text": text })))
            }
            Call::Screenshot {
                full_page, target, ..
            } => {
                let data = picture(w, full_page, target.as_deref()).await?;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "data": data, "mime": "image/jpeg" }),
                ))
            }
            Call::Console { .. } => {
                let lines: Vec<String> = with_page(&tab, |p| p.console.drain(..).collect());
                Ok(page_answer(app, &tab, json!({ "lines": lines })))
            }
            Call::Network { .. } => {
                let lines: Vec<String> = with_page(&tab, |p| p.network.drain(..).collect());
                Ok(page_answer(app, &tab, json!({ "lines": lines })))
            }
            Call::Evaluate { script, .. } => {
                let trimmed = script.trim();
                // A function body ("...; return x") runs as one; anything else
                // is an expression.
                let body = trimmed.starts_with("return ")
                    || trimmed.contains("\nreturn ")
                    || trimmed.contains("; return ");
                let expression = if body {
                    format!("(async () => {{\n{trimmed}\n}})()")
                } else {
                    trimmed.to_string()
                };
                let answer = win::cdp(
                    w,
                    "Runtime.evaluate",
                    json!({
                        "expression": expression, "returnByValue": true,
                        "awaitPromise": true, "userGesture": true, "timeout": 20000,
                    }),
                )
                .await?;
                if let Some(error) = exception(&answer) {
                    return Err(format!("the script threw: {error}"));
                }
                let result = &answer["result"];
                let value = result
                    .get("value")
                    .cloned()
                    .or_else(|| result["description"].as_str().map(|d| json!(d)))
                    .unwrap_or(Value::Null);
                let shown = match &value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let shown = if shown.chars().count() > 20_000 {
                    format!("{}… (cut)", shown.chars().take(20_000).collect::<String>())
                } else {
                    shown
                };
                Ok(page_answer(app, &tab, json!({ "result": shown })))
            }
            Call::Wait { text, gone, ms, .. } => {
                let limit = Duration::from_millis(ms.unwrap_or(20_000).min(30_000));
                let start = std::time::Instant::now();
                let (wanted, appear) = match (&text, &gone) {
                    (Some(t), _) => (t.clone(), true),
                    (None, Some(g)) => (g.clone(), false),
                    (None, None) => {
                        tokio::time::sleep(limit).await;
                        return Ok(page_answer(
                            app,
                            &tab,
                            json!({ "text": format!("Waited {} ms.", limit.as_millis()) }),
                        ));
                    }
                };
                loop {
                    let found = helper(w, &format!("text().includes({})", js(&wanted)))
                        .await
                        .map(|v| v == true)
                        .unwrap_or(false);
                    if found == appear {
                        let said = if appear {
                            format!("\"{wanted}\" is on the page.")
                        } else {
                            format!("\"{wanted}\" is gone from the page.")
                        };
                        return Ok(page_answer(app, &tab, json!({ "text": said })));
                    }
                    if start.elapsed() >= limit {
                        return Err(format!(
                            "\"{wanted}\" {} within {} s",
                            if appear { "didn't appear" } else { "didn't go" },
                            limit.as_secs()
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
            Call::Viewport { size, .. } => {
                match size {
                    Some((width, height)) => {
                        win::cdp(
                            w,
                            "Emulation.setDeviceMetricsOverride",
                            json!({ "width": width, "height": height, "deviceScaleFactor": 0, "mobile": false }),
                        )
                        .await?;
                    }
                    None => {
                        win::cdp(w, "Emulation.clearDeviceMetricsOverride", json!({})).await?;
                    }
                }
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": "The page's size changed." }),
                ))
            }
            Call::Dialog { accept, text, .. } => {
                let Some((kind, message)) = with_page(&tab, |p| p.dialog.take()) else {
                    return Err("no alert, confirm or prompt is open on this page".into());
                };
                win::cdp(
                    w,
                    "Page.handleJavaScriptDialog",
                    json!({ "accept": accept, "promptText": text.unwrap_or_default() }),
                )
                .await?;
                settle(app, &tab, false).await;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": format!("{} the {kind} \"{message}\".", if accept { "Accepted" } else { "Dismissed" }) }),
                ))
            }
            Call::Upload { target, paths, .. } => {
                let count = paths.len();
                let input = eval(
                    w,
                    &format!("__openremote.fileInput({})", js(&target)),
                    false,
                )
                .await?;
                if let Some(object) = input["objectId"].as_str() {
                    win::cdp(
                        w,
                        "DOM.setFileInputFiles",
                        json!({ "files": paths, "objectId": object }),
                    )
                    .await?;
                } else {
                    // No file input in reach: press the element and catch
                    // the file picker the page opens.
                    win::cdp(
                        w,
                        "Page.setInterceptFileChooserDialog",
                        json!({ "enabled": true }),
                    )
                    .await?;
                    with_page(&tab, |p| p.chooser = None);
                    let (at, _) = aim(w, &target).await?;
                    mouse(w, "mousePressed", at, "left", 1).await?;
                    mouse(w, "mouseReleased", at, "left", 1).await?;
                    let mut node = None;
                    for _ in 0..30 {
                        node = with_page(&tab, |p| p.chooser.take());
                        if node.is_some() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    let _ = win::cdp(
                        w,
                        "Page.setInterceptFileChooserDialog",
                        json!({ "enabled": false }),
                    )
                    .await;
                    let node =
                        node.ok_or_else(|| format!("pressing {target} didn't open a file picker"))?;
                    win::cdp(
                        w,
                        "DOM.setFileInputFiles",
                        json!({ "files": paths, "backendNodeId": node }),
                    )
                    .await?;
                }
                settle(app, &tab, false).await;
                Ok(page_answer(
                    app,
                    &tab,
                    json!({ "text": format!("Put {count} file(s) into the picker.") }),
                ))
            }
            other => Err(format!("the browser can't {other:?} here")),
        }
    }

    /// A JPEG of the visible page, the whole page, or one element (by ref),
    /// sized so a model can take it (no side past about 7800 pixels).
    pub async fn picture(
        webview: &Webview,
        full_page: bool,
        target: Option<&str>,
    ) -> Result<String, String> {
        let mut params = json!({ "format": "jpeg", "quality": 70 });
        let clip = match target {
            Some(target) => Some(helper(webview, &format!("rect({})", js(target))).await?),
            None if full_page => {
                let page = helper(webview, "page()").await?;
                Some(json!({ "x": 0, "y": 0, "width": page["width"], "height": page["height"] }))
            }
            None => None,
        };
        if let Some(clip) = clip {
            let page = helper(webview, "page()").await?;
            let dpr = page["dpr"].as_f64().unwrap_or(1.0).max(0.5);
            let width = clip["width"].as_f64().unwrap_or(1.0).max(1.0);
            let height = clip["height"].as_f64().unwrap_or(1.0).max(1.0);
            let scale = (1.0 / dpr)
                .min(7800.0 / (height * dpr))
                .min(7800.0 / (width * dpr));
            params["clip"] = json!({
                "x": clip["x"], "y": clip["y"], "width": width, "height": height, "scale": scale,
            });
            params["captureBeyondViewport"] = json!(true);
        }
        let shot = tokio::time::timeout(
            Duration::from_secs(15),
            win::cdp(webview, "Page.captureScreenshot", params),
        )
        .await
        .map_err(|_| "the page didn't draw in time".to_string())??;
        shot["data"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "no picture came back".into())
    }

    /// Start or stop the element picker in a tab.
    pub async fn pick(app: &AppHandle, webview: &Webview, on: bool) -> Result<(), String> {
        instrument(app, webview).await?;
        let tab = webview.label().to_string();
        if on && !with_page(&tab, |p| std::mem::replace(&mut p.picker_bound, true)) {
            win::cdp(
                webview,
                "Runtime.addBinding",
                json!({ "name": PICKED, "executionContextName": WORLD }),
            )
            .await?;
            // A world made before the binding existed doesn't have it.
            with_page(&tab, |p| p.world = None);
        }
        helper(webview, &format!("pick({on})")).await?;
        if on {
            let _ = webview.set_focus();
        }
        Ok(())
    }

    /// The element the user picked: its details and its picture, for the
    /// composer.
    async fn picked(app: &AppHandle, tab: &str, payload: &str) {
        let console = super::super::console();
        let Ok(element) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        if element["cancel"] == true {
            let _ = app.emit_to(
                console,
                "browser:picking",
                json!({ "tab": tab, "on": false }),
            );
            return;
        }
        let mut image = Value::Null;
        if let Ok(webview) = super::super::tab(app, tab) {
            let rect = &element["rect"];
            let clip = json!({
                "x": rect["x"], "y": rect["y"],
                "width": rect["width"].as_f64().unwrap_or(1.0).max(1.0),
                "height": rect["height"].as_f64().unwrap_or(1.0).max(1.0),
                "scale": 1,
            });
            if let Ok(Ok(shot)) = tokio::time::timeout(
                Duration::from_secs(10),
                win::cdp(
                    &webview,
                    "Page.captureScreenshot",
                    json!({ "format": "jpeg", "quality": 80, "clip": clip, "captureBeyondViewport": true }),
                ),
            )
            .await
            {
                if let Some(data) = shot["data"].as_str() {
                    image = json!(format!("data:image/jpeg;base64,{data}"));
                }
            }
        }
        let _ = app.emit_to(
            console.clone(),
            "browser:picking",
            json!({ "tab": tab, "on": false }),
        );
        let _ = app.emit_to(
            console,
            "browser:picked",
            json!({ "tab": tab, "element": element, "image": image }),
        );
    }

    /// Start or stop a tab's stream of frames (recording).
    pub async fn screencast(app: &AppHandle, webview: &Webview, on: bool) -> Result<(), String> {
        instrument(app, webview).await?;
        if on {
            win::cdp(
                webview,
                "Page.startScreencast",
                json!({ "format": "jpeg", "quality": 60, "maxWidth": 1280, "maxHeight": 1280 }),
            )
            .await
            .map(|_| ())
        } else {
            win::cdp(webview, "Page.stopScreencast", json!({}))
                .await
                .map(|_| ())
        }
    }
}
