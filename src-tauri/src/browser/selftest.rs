//! A debug build's check of the browser engine on the real window: run
//! with OPENREMOTE_BROWSER_SELFTEST=<file>, it opens tabs, drives them
//! through the DevTools protocol, tries the app's own addresses and
//! commands from a page, hides the window, writes what it found to <file>
//! as JSON and quits. Release builds don't contain it.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, Webview};

use super::{open_tab, win, Bounds, Browser};

const PAGE: &str = "data:text/html,<title>selftest</title>\
<button id=b style='position:fixed;left:40px;top:40px;width:200px;height:60px' \
onclick=\"document.title='clicked:'+event.isTrusted\">Click</button>\
<input id=i style='position:fixed;left:40px;top:140px'>\
<a id=p href='https://example.org/' target='_blank'>popup</a>";

pub fn start(app: AppHandle, out: std::path::PathBuf) {
    tauri::async_runtime::spawn(async move {
        // Let the window and the console settle first.
        tokio_sleep(Duration::from_secs(4)).await;
        let report = run(&app).await;
        let _ = std::fs::write(&out, serde_json::to_vec_pretty(&report).unwrap_or_default());
        app.exit(0);
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

async fn eval(tab: &Webview, expr: &str) -> Value {
    match win::cdp(
        tab,
        "Runtime.evaluate",
        json!({ "expression": expr, "awaitPromise": true, "returnByValue": true, "userGesture": true }),
    )
    .await
    {
        Ok(v) => v["result"]["value"].clone(),
        Err(e) => json!({ "error": e }),
    }
}

async fn wait_loaded(tab: &Webview) -> bool {
    for _ in 0..50 {
        if eval(tab, "document.readyState").await == json!("complete") {
            return true;
        }
        tokio_sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn click_at(tab: &Webview, x: f64, y: f64) -> Result<(), String> {
    for kind in ["mousePressed", "mouseReleased"] {
        win::cdp(
            tab,
            "Input.dispatchMouseEvent",
            json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
        )
        .await?;
    }
    Ok(())
}

async fn run(app: &AppHandle) -> Value {
    let mut r = serde_json::Map::new();
    let bounds = Bounds {
        x: 300.0,
        y: 120.0,
        width: 900.0,
        height: 600.0,
    };

    let t = Instant::now();
    let id = match open_tab(
        app.clone(),
        Url::parse(PAGE).unwrap(),
        bounds,
        true,
        None,
        false,
    ) {
        Ok(id) => id,
        Err(e) => return json!({ "open_tab": { "error": e } }),
    };
    r.insert("open_tab_ms".into(), json!(t.elapsed().as_millis()));
    let tab = app.get_webview(&id).expect("tab just opened");
    r.insert("loaded".into(), json!(wait_loaded(&tab).await));

    // Where the tab sits against where it was asked to sit.
    let scale = app.get_window("main").and_then(|w| w.scale_factor().ok());
    r.insert(
        "bounds".into(),
        json!({ "asked_logical": bounds, "scale": scale, "got": format!("{:?}", tab.bounds()) }),
    );

    // The snapshot swap's picture, five times.
    let mut shots = Vec::new();
    let mut bytes = 0;
    for _ in 0..5 {
        let t = Instant::now();
        match win::cdp(
            &tab,
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 80 }),
        )
        .await
        {
            Ok(v) => {
                bytes = v["data"].as_str().map_or(0, str::len);
                shots.push(t.elapsed().as_millis());
            }
            Err(e) => {
                r.insert("screenshot_error".into(), json!(e));
                break;
            }
        }
    }
    r.insert("screenshot_ms".into(), json!(shots));
    r.insert("screenshot_base64_bytes".into(), json!(bytes));

    // The page as an agent reads it.
    match win::cdp(&tab, "Accessibility.getFullAXTree", json!({})).await {
        Ok(v) => {
            let nodes = v["nodes"].as_array().map_or(0, Vec::len);
            let button = v["nodes"].as_array().is_some_and(|n| {
                n.iter().any(|node| {
                    node["role"]["value"] == "button" && node["name"]["value"] == "Click"
                })
            });
            r.insert("ax_nodes".into(), json!(nodes));
            r.insert("ax_finds_button".into(), json!(button));
        }
        Err(e) => {
            r.insert("ax_error".into(), json!(e));
        }
    }

    // Trusted input: a real click, then typing.
    let clicked = click_at(&tab, 140.0, 70.0).await;
    tokio_sleep(Duration::from_millis(200)).await;
    r.insert(
        "click".into(),
        json!({ "sent": clicked.is_ok(), "title": eval(&tab, "document.title").await }),
    );
    let _ = click_at(&tab, 100.0, 150.0).await;
    let _ = win::cdp(&tab, "Input.insertText", json!({ "text": "hello" })).await;
    r.insert(
        "typed".into(),
        eval(&tab, "document.getElementById('i').value").await,
    );

    // The app's commands from a page: must be refused.
    r.insert(
        "ipc_from_tab".into(),
        eval(
            &tab,
            "window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke('daemon_info').then(r => 'LEAKED ' + Object.keys(r || {}).join(','), e => 'refused: ' + e) : 'no ipc in page'",
        )
        .await,
    );

    // The app's own addresses from a page: must stay out of reach.
    let _ = eval(&tab, "location.href = 'http://tauri.localhost/'; 'sent'").await;
    tokio_sleep(Duration::from_millis(1500)).await;
    r.insert(
        "after_app_address".into(),
        eval(&tab, "location.href").await,
    );

    // A popup becomes a tab.
    let before = app.state::<Browser>().tabs.lock().expect("lock").len();
    let _ = eval(&tab, "document.getElementById('p').click(); 'clicked'").await;
    tokio_sleep(Duration::from_secs(3)).await;
    let tabs: Vec<(String, String, Option<String>)> = app
        .state::<Browser>()
        .tabs
        .lock()
        .expect("lock")
        .values()
        .map(|t| (t.id.clone(), t.url.clone(), t.opener.clone()))
        .collect();
    r.insert("popup".into(), json!({ "before": before, "after": tabs }));

    // A real site.
    let t = Instant::now();
    match open_tab(
        app.clone(),
        Url::parse("https://example.com/").unwrap(),
        bounds,
        true,
        None,
        false,
    ) {
        Ok(site) => {
            let site = app.get_webview(&site).expect("tab just opened");
            let loaded = wait_loaded(&site).await;
            r.insert(
                "example_com".into(),
                json!({ "loaded": loaded, "ms": t.elapsed().as_millis(), "title": eval(&site, "document.title").await }),
            );
        }
        Err(e) => {
            r.insert("example_com".into(), json!({ "error": e }));
        }
    }

    // Hidden in the tray: the page still runs and still answers.
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
        tokio_sleep(Duration::from_secs(2)).await;
        let _ = eval(
            &tab,
            "window.__ticks = 0; setInterval(() => window.__ticks++, 100); 'ok'",
        )
        .await;
        tokio_sleep(Duration::from_secs(2)).await;
        let ticks = eval(&tab, "window.__ticks").await;
        let t = Instant::now();
        let shot = win::cdp(
            &tab,
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 80 }),
        )
        .await;
        r.insert(
            "hidden_window".into(),
            json!({
                "timer_ticks_in_2s": ticks,
                "screenshot_ms": t.elapsed().as_millis(),
                "screenshot_ok": shot.as_ref().is_ok_and(|v| v["data"].as_str().is_some_and(|d| d.len() > 1000)),
                "error": shot.err(),
            }),
        );
        let _ = window.show();
    }

    Value::Object(r)
}
