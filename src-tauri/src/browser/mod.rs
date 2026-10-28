//! The built-in browser's engine on the desktop. Each tab is a native
//! webview (WebView2 on Windows, WebKit on macOS and Linux) laid over a
//! placeholder the console draws, in a profile folder of its own, so web
//! pages never share storage with the console. The console owns the
//! browser's chrome (tab strip, address bar, menus); the shell owns the
//! pages and tells the console what they do through `browser:*` events.
//!
//! Tabs are webviews in the console's own window, so two rules keep them
//! away from the app: the app's commands answer only the console's webview
//! (the ACL in build.rs and capabilities/default.json), and a tab never
//! loads the app's own addresses (`allowed`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, Url, Webview,
    WebviewUrl,
};

#[cfg(all(windows, debug_assertions))]
pub mod selftest;
#[cfg(windows)]
mod win;

/// The console's webview: the only one that hears the browser's events.
const CONSOLE: &str = "main";

static DOWNLOADS: AtomicU64 = AtomicU64::new(0);

/// The tabs this window holds, by id.
#[derive(Default)]
pub struct Browser {
    next: AtomicU64,
    tabs: Mutex<HashMap<String, Tab>>,
}

/// What the console is told about a tab.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Tab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// The page's icon as a data URL (the console shows no remote images).
    pub favicon: Option<String>,
    pub can_back: bool,
    pub can_forward: bool,
    /// The tab that opened this one (a link with target=_blank or
    /// window.open), so the console can place it beside its opener.
    pub opener: Option<String>,
    #[serde(skip)]
    bounds: Option<Bounds>,
}

/// A download a tab asked for, as the console lists it.
#[derive(Clone, Debug, Serialize)]
pub struct Download {
    pub id: u64,
    pub tab: String,
    pub url: String,
    pub path: Option<String>,
    /// "blocked" (a page asked and was refused), "started", "done" or
    /// "failed".
    pub state: &'static str,
}

/// One tab's download attempts, as the shell reports them.
///
/// One attempt is one row in the console's downloads list, and the event
/// that ends an attempt carries nothing but its address. So an attempt the
/// handler allows keeps its id here, under its address, and the finish event
/// lands on the row that attempt already has. Nothing is kept for a refused
/// attempt: it was reported as blocked when it arrived, nothing was started,
/// and a completion for it (WebView2 reports the cancellation of an operation
/// it started and then cancelled) is the engine's own bookkeeping rather than
/// news about a second download. Dropping it is what keeps one attempt to one
/// row whether or not that completion ever fires - and the id fallback that
/// used to make every later attempt rewrite a single row is gone with it.
#[derive(Default)]
struct Downloads {
    started: Vec<(String, u64)>,
}

impl Downloads {
    /// The row to report for this event, or none when the event is not news
    /// about a row the console holds. `id` hands out the next download id,
    /// and only a request takes one; `answer` is what the handler will tell
    /// the engine for this event's attempt.
    fn reported(
        &mut self,
        event: &DownloadEvent<'_>,
        id: impl FnOnce() -> u64,
        tab: &str,
        answer: bool,
    ) -> Option<Download> {
        match event {
            DownloadEvent::Requested { url, destination } => {
                let id = id();
                if answer {
                    self.started.push((url.to_string(), id));
                }
                Some(Download {
                    id,
                    tab: tab.to_string(),
                    url: url.to_string(),
                    path: Some(destination.display().to_string()),
                    state: if answer { "started" } else { "blocked" },
                })
            }
            DownloadEvent::Finished { url, path, success } => {
                if !answer {
                    return None;
                }
                let url = url.to_string();
                let at = self.started.iter().rposition(|(u, _)| *u == url);
                // No started attempt with this address: the console has no
                // row for it, and inventing one would list a download
                // nobody asked for.
                let id = at.map(|at| self.started.remove(at).1)?;
                Some(Download {
                    id,
                    tab: tab.to_string(),
                    url,
                    path: path.as_ref().map(|p| p.display().to_string()),
                    state: if *success { "done" } else { "failed" },
                })
            }
            // The enum is non-exhaustive: an event this shell has never
            // been told about is not a row, and the answer above stands.
            _ => None,
        }
    }
}

/// Where the console's placeholder sits, in CSS pixels. The console's
/// webview fills the window from its top-left corner, so CSS pixels are
/// the window's logical pixels and Tauri scales them for the display.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A browser key pressed while a page had focus: the page never sees it
/// and the console acts on it (`Mod+T`, the app's own `Mod+K`...).
///
/// Built only by the Windows backend, where the WebView2 accelerator handler is what
/// reports the key; the other two platforms let the console's own listener see it, so
/// on Linux this type is declared and never constructed, which `-D warnings` reads as
/// dead code. The allow is that fact, not a silence.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Debug, Serialize)]
pub struct KeyPress {
    pub tab: String,
    pub chord: String,
}

/// Whether a tab may load this address. The console is served from
/// `tauri.localhost` (and in development from the dev server), and Tauri
/// answers its IPC and asset schemes on other `*.localhost` names in every
/// webview of the app, so those stay out of reach. Plain `localhost` and
/// 127.0.0.1 stay open: they are the user's own dev servers.
pub fn allowed(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or("").trim_end_matches('.');
            if host.ends_with(".localhost") {
                return false;
            }
            !dev.is_some_and(|dev| dev.origin() == url.origin())
        }
        "about" | "blob" | "data" | "file" => true,
        _ => false,
    }
}

/// Whether a page may start a download on its own. It may not. Tauri
/// reports a download as it arrives and takes the handler's answer as
/// allow-or-refuse, so there is no way to hold it and ask the user first:
/// every allowed download is a file written where the user keeps their
/// own, with nothing on screen to say a page put it there. The console
/// lists the attempt instead, and the user who wants the file asks for it
/// in a browser that prompts.
fn page_may_download() -> bool {
    false
}

/// The browser's profile: cookies, storage and cache live here, apart
/// from the console's own.
fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // A test run points the profile somewhere disposable.
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("OPENREMOTE_BROWSER_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("browser").join("profile"))
}

/// The console's webview, for anything the shell has to tell it directly.
pub(crate) fn console() -> EventTarget {
    EventTarget::Webview {
        label: CONSOLE.into(),
    }
}

/// Give the console's webview no engine context menu.
///
/// The console is the app's own chrome: every action on it is a control the
/// console draws, and the engine's menu offers what the app never had. It is
/// also the webview that must never be talked into a download from a menu
/// item. Tabs are the other way round: their menu is the only menu a page
/// has, so they keep it (see `open_tab`). Only Windows' engine has one to
/// turn off; the other engines are left as they are.
pub fn no_engine_menu(webview: &Webview) {
    #[cfg(windows)]
    win::no_default_menu(webview);
    #[cfg(not(windows))]
    let _ = webview;
}

fn tab(app: &AppHandle, id: &str) -> Result<Webview, String> {
    app.get_webview(id)
        .filter(|_| id.starts_with("tab-"))
        .ok_or_else(|| format!("no tab {id}"))
}

/// Change what the shell knows about a tab and tell the console.
fn update(app: &AppHandle, id: &str, change: impl FnOnce(&mut Tab)) {
    let browser = app.state::<Browser>();
    let snapshot = {
        let mut tabs = browser.tabs.lock().expect("browser lock");
        let Some(tab) = tabs.get_mut(id) else {
            return;
        };
        change(tab);
        tab.clone()
    };
    let _ = app.emit_to(console(), "browser:tab", snapshot);
}

/// Open a tab. It blocks until the window's thread has built the webview
/// (Tauri's add_child waits on it), so it must never run on that thread:
/// commands call it from the async runtime, and a page's popup from the
/// blocking pool.
pub fn open_tab(
    app: AppHandle,
    url: Url,
    bounds: Bounds,
    show: bool,
    opener: Option<String>,
) -> Result<String, String> {
    if !allowed(&url, app.config().build.dev_url.as_ref()) {
        return Err(format!("{url} can't be opened here"));
    }
    let browser = app.state::<Browser>();
    let id = format!("tab-{}", browser.next.fetch_add(1, Ordering::Relaxed) + 1);
    let window = app.get_window(CONSOLE).ok_or("the window is gone")?;
    let dev = app.config().build.dev_url.clone();
    let (on_load, on_title, on_popup, on_download) =
        (app.clone(), app.clone(), app.clone(), app.clone());
    // Downloads are told apart by their address, which is all the finish
    // event carries: the newest started one with that address finishes. A
    // download the handler allows is remembered; a refused one is not, and
    // its completion is not reported (see `Downloads`).
    let downloads = Mutex::new(Downloads::default());
    let popup_from = id.clone();
    let builder = WebviewBuilder::new(&id, WebviewUrl::External(url.clone()))
        .data_directory(profile_dir(&app)?)
        .on_navigation(move |to| allowed(to, dev.as_ref()))
        .on_page_load(move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let url = payload.url().to_string();
            update(&on_load, webview.label(), |tab| {
                tab.loading = loading;
                tab.url = url;
            });
        })
        .on_document_title_changed(move |webview, title| {
            update(&on_title, webview.label(), |tab| tab.title = title);
        })
        // A page asking for a new window gets a tab instead. The page stays
        // hidden until the console says it has the tab: a pane that closed
        // while the page was being built must not leave it drawn over the
        // console with no tab strip to close it.
        .on_new_window(move |url, _features| {
            let app = on_popup.clone();
            let opener = popup_from.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let bounds = app
                    .state::<Browser>()
                    .tabs
                    .lock()
                    .expect("browser lock")
                    .get(&opener)
                    .and_then(|tab| tab.bounds);
                if let Some(bounds) = bounds {
                    let _ = open_tab(app, url, bounds, false, Some(opener));
                }
            });
            NewWindowResponse::Deny
        })
        // A page never writes a file on its own. Above where WebView2 would
        // put it (the user's Downloads folder, a free name) and behind Edge's
        // own bubble, a download the page starts is a file the user never
        // agreed to; the event can only be allowed or refused as it arrives,
        // so there is no way to hold it and ask the user first. It is
        // refused, and the console is told what the page tried to save.
        .on_download(move |webview, event| {
            let answer = page_may_download();
            let row = downloads.lock().expect("downloads lock").reported(
                &event,
                || DOWNLOADS.fetch_add(1, Ordering::Relaxed) + 1,
                webview.label(),
                answer,
            );
            if let Some(row) = row {
                let _ = on_download.emit_to(console(), "browser:download", row);
            }
            answer
        });
    // A tab keeps the engine's own context menu, and that is a decision
    // with a cost, not an oversight: it is the only menu a page has (copy,
    // select all, back and reload all work from it), and the app has no page
    // menu of its own to replace it with. The engine's menu also offers
    // "Save page as" and "Print", which write a file without passing through
    // `on_download` above. Replacing it means handling ContextMenuRequested,
    // drawing a menu in the console's own webview over a parked page, and
    // wiring each item to the tab: a real piece of work, and until it exists
    // the engine's menu is the better one to have. The console's webview has
    // no such excuse and is turned off (`no_engine_menu`, from the desktop
    // setup).
    #[cfg(windows)]
    let builder = builder.additional_browser_args(win::BROWSER_ARGS);
    browser.tabs.lock().expect("browser lock").insert(
        id.clone(),
        Tab {
            id: id.clone(),
            url: url.to_string(),
            loading: true,
            opener: opener.clone(),
            bounds: Some(bounds),
            ..Tab::default()
        },
    );
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| {
            browser.tabs.lock().expect("browser lock").remove(&id);
            e.to_string()
        })?;
    if !show {
        let _ = webview.hide();
    }
    #[cfg(windows)]
    win::attach(&app, &webview);
    update(&app, &id, |_| {});
    Ok(id)
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: String,
    bounds: Bounds,
    show: bool,
) -> Result<String, String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    open_tab(app, url, bounds, show, None)
}

/// What this build's shell can actually do with a tab. Find, the DevTools
/// bridge (element picking and screenshots), device view, printing and
/// forgetting a site are written against WebView2, so every other build
/// answers false and the console keeps those controls off its chrome instead
/// of drawing buttons that fail silently. DevTools ride with the build type
/// rather than the platform: the command exists in a development build and
/// nowhere else.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub find: bool,
    /// Screenshots and the DevTools protocol: element picking.
    pub cdp: bool,
    /// Device view, which drives the page's emulation over the bridge.
    pub viewport: bool,
    pub clear_site: bool,
    pub print: bool,
    pub devtools: bool,
}

#[tauri::command]
pub fn browser_features() -> Features {
    #[cfg(windows)]
    return Features {
        find: true,
        cdp: true,
        viewport: true,
        clear_site: true,
        print: true,
        devtools: cfg!(debug_assertions),
    };
    #[cfg(not(windows))]
    Features {
        find: false,
        cdp: false,
        viewport: false,
        clear_site: false,
        // Printing is not a Windows-only feature: wry implements it as the
        // system's own dialog on WebKitGTK and WKWebView too, and this crate
        // has the non-Windows arm for it below. Gating it here disabled a
        // control that works.
        print: true,
        devtools: cfg!(debug_assertions),
    }
}

/// The tabs the shell holds, oldest first: a console that reloaded takes
/// them back instead of leaving them on screen, orphaned.
#[tauri::command]
pub fn browser_tabs(browser: State<'_, Browser>) -> Vec<Tab> {
    let mut tabs: Vec<Tab> = browser
        .tabs
        .lock()
        .expect("browser lock")
        .values()
        .cloned()
        .collect();
    tabs.sort_by_key(|t| t.id.trim_start_matches("tab-").parse::<u64>().unwrap_or(0));
    tabs
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    browser: State<'_, Browser>,
    tab: String,
) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    browser.tabs.lock().expect("browser lock").remove(&tab);
    webview.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, tab: String, bounds: Bounds) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    if let Some(known) = app
        .state::<Browser>()
        .tabs
        .lock()
        .expect("browser lock")
        .get_mut(&tab)
    {
        known.bounds = Some(bounds);
    }
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_show(app: AppHandle, tab: String, focus: bool) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    webview.show().map_err(|e| e.to_string())?;
    if focus {
        let _ = webview.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, tab: String) -> Result<(), String> {
    self::tab(&app, &tab)?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, tab: String, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !allowed(&url, app.config().build.dev_url.as_ref()) {
        return Err(format!("{url} can't be opened here"));
    }
    self::tab(&app, &tab)?
        .navigate(url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_back(app: AppHandle, tab: String) -> Result<(), String> {
    history(&self::tab(&app, &tab)?, -1)
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, tab: String) -> Result<(), String> {
    history(&self::tab(&app, &tab)?, 1)
}

fn history(webview: &Webview, step: i32) -> Result<(), String> {
    #[cfg(windows)]
    return win::history(webview, step);
    #[cfg(not(windows))]
    webview
        .eval(format!("history.go({step})"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, tab: String) -> Result<(), String> {
    self::tab(&app, &tab)?.reload().map_err(|e| e.to_string())
}

/// A picture of the tab as it is now, as a data URL: the console shows it
/// in the tab's place while one of its own menus or dialogs covers the
/// page (a native webview always draws above the console's HTML).
#[tauri::command]
pub async fn browser_capture(app: AppHandle, tab: String) -> Result<String, String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    {
        let shot = win::cdp(
            &webview,
            "Page.captureScreenshot",
            serde_json::json!({ "format": "jpeg", "quality": 80 }),
            Wait::Deadline,
        )
        .await?;
        let data = shot["data"].as_str().ok_or("no picture came back")?;
        Ok(format!("data:image/jpeg;base64,{data}"))
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err("not on this platform yet".into())
    }
}

/// What a DevTools call is waiting for, which is what decides whether it may
/// ever be given up on. The console sends it with every call. These are two
/// different questions and not two lengths of one: a page that owes the
/// console an answer can be declared stuck, but a person aiming at an
/// element is not stuck, and a pick that ends before they click is a bug.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Wait {
    /// The console asked the page a question (a screenshot, a viewport
    /// change, forgetting a site) and is given up on after a deadline, so a
    /// stalled page costs one failure instead of the pane.
    Deadline,
    /// The console is waiting for the person: an element pick, which ends
    /// when they click, press Esc or cancel. No deadline applies, because
    /// how long someone takes to choose is theirs.
    User,
}

/// One DevTools protocol call on a tab, in-process: no debugging port is
/// ever opened, so nothing else on the machine can attach to the browser.
/// `wait` is how long the console is willing to wait for the answer, and it
/// is not optional: the shell has two kinds of waiting (a page that owes an
/// answer, a person who is answering) and every call has to say which one
/// it is, so neither can quietly become the other.
#[tauri::command]
pub async fn browser_cdp(
    app: AppHandle,
    tab: String,
    method: String,
    params: serde_json::Value,
    wait: Wait,
) -> Result<serde_json::Value, String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::cdp(&webview, &method, params, wait).await;
    #[cfg(not(windows))]
    {
        let _ = (webview, method, params, wait);
        Err("not on this platform yet".into())
    }
}

/// Stop loading the page.
#[tauri::command]
pub fn browser_stop(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::stop(&webview);
    #[cfg(not(windows))]
    webview.eval("window.stop()").map_err(|e| e.to_string())
}

/// The page's zoom, 1.0 being 100%.
#[tauri::command]
pub fn browser_zoom(app: AppHandle, tab: String, factor: f64) -> Result<(), String> {
    self::tab(&app, &tab)?
        .set_zoom(factor.clamp(0.25, 5.0))
        .map_err(|e| e.to_string())
}

/// Find in page: a term to look for (and step through with `step`, 1 or
/// -1), the matches arriving as `browser:find` events. An empty term ends
/// the search.
#[tauri::command]
pub fn browser_find(app: AppHandle, tab: String, term: String, step: i32) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::find(&app, &webview, term, step);
    #[cfg(not(windows))]
    {
        let _ = (app, webview, term, step);
        Err("not on this platform yet".into())
    }
}

#[tauri::command]
pub fn browser_print(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    return win::print(&webview);
    #[cfg(not(windows))]
    webview.print().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_devtools(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    // Release builds gain DevTools with the browser's first release; the
    // console only offers the item in development until then.
    #[cfg(debug_assertions)]
    {
        webview.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = webview;
        Err("DevTools aren't in this build yet".into())
    }
}

/// Show the page as another screen shows it: a phone's or any width and
/// height, drawn at `scale` when the space is smaller than the screen, and
/// for a phone with touch and a phone's user agent (what the browser's
/// own developer tools do). No size: the tab's own size again.
#[tauri::command]
pub async fn browser_viewport(
    app: AppHandle,
    tab: String,
    width: Option<u32>,
    height: Option<u32>,
    mobile: bool,
    scale: Option<f64>,
) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    #[cfg(windows)]
    {
        let Some((w, h)) = width.zip(height) else {
            win::cdp(
                &webview,
                "Emulation.clearDeviceMetricsOverride",
                serde_json::json!({}),
                Wait::Deadline,
            )
            .await?;
            win::cdp(
                &webview,
                "Emulation.setTouchEmulationEnabled",
                serde_json::json!({ "enabled": false }),
                Wait::Deadline,
            )
            .await?;
            win::cdp(
                &webview,
                "Emulation.setUserAgentOverride",
                serde_json::json!({ "userAgent": "" }),
                Wait::Deadline,
            )
            .await?;
            return Ok(());
        };
        win::cdp(
            &webview,
            "Emulation.setDeviceMetricsOverride",
            serde_json::json!({
                "width": w.clamp(200, 3840),
                "height": h.clamp(200, 2160),
                "deviceScaleFactor": 0,
                "mobile": mobile,
                "scale": scale.unwrap_or(1.0).clamp(0.1, 1.0),
            }),
            Wait::Deadline,
        )
        .await?;
        win::cdp(
            &webview,
            "Emulation.setTouchEmulationEnabled",
            serde_json::json!({ "enabled": mobile, "maxTouchPoints": 5 }),
            Wait::Deadline,
        )
        .await?;
        let agent = if mobile {
            // The engine's own user agent, as its Android build words it.
            let found = win::cdp(
                &webview,
                "Browser.getVersion",
                serde_json::json!({}),
                Wait::Deadline,
            )
            .await?;
            phone_agent(found["userAgent"].as_str().unwrap_or_default())
        } else {
            String::new()
        };
        win::cdp(
            &webview,
            "Emulation.setUserAgentOverride",
            serde_json::json!({ "userAgent": agent }),
            Wait::Deadline,
        )
        .await
        .map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, width, height, mobile, scale);
        Err("not on this platform yet".into())
    }
}

/// A desktop Chromium user agent as the same engine's Android build sends
/// it, so sites serve the phone layout in device view.
#[cfg_attr(not(windows), allow(dead_code))]
fn phone_agent(desktop: &str) -> String {
    let Some(open) = desktop.find('(') else {
        return String::new();
    };
    let Some(close) = desktop[open..].find(')').map(|i| open + i) else {
        return String::new();
    };
    let rest = desktop[close + 1..].replace(" Safari/", " Mobile Safari/");
    // Edge's token is not on Android's Chromium.
    let rest = rest.split(" Edg/").next().unwrap_or(&rest).to_string();
    format!("{}(Linux; Android 10; K){rest}", &desktop[..open])
}

/// Forget the current site: its cookies, storage and cache.
#[tauri::command]
pub async fn browser_clear_site(app: AppHandle, tab: String) -> Result<(), String> {
    let webview = self::tab(&app, &tab)?;
    let url = webview.url().map_err(|e| e.to_string())?;
    let origin = url.origin().ascii_serialization();
    if origin == "null" {
        return Err("this page has no site to clear".into());
    }
    #[cfg(windows)]
    {
        win::cdp(
            &webview,
            "Storage.clearDataForOrigin",
            serde_json::json!({ "origin": origin, "storageTypes": "all" }),
            Wait::Deadline,
        )
        .await?;
        webview.reload().map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err("not on this platform yet".into())
    }
}

/// Open the page in the system's default browser.
#[tauri::command]
pub fn browser_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only web pages open outside".into());
    }
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(url.as_str(), None)
        .map_err(|e| e.to_string())
}

/// Show a finished download in the file manager.
#[tauri::command]
pub fn browser_reveal(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.exists() {
        return Err("that file is gone".into());
    }
    #[cfg(windows)]
    let shown = std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&path)
        .spawn();
    #[cfg(target_os = "macos")]
    let shown = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let shown = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .spawn();
    shown.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn tabs_never_load_the_apps_own_addresses() {
        let dev = url("http://127.0.0.1:5175/");
        for app in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://ipc.localhost/daemon_info",
            "http://asset.localhost/x",
            "http://tauri.localhost./",
            "http://127.0.0.1:5175/",
            "tauri://localhost/",
            "ipc://localhost/",
            "javascript:alert(1)",
        ] {
            assert!(!allowed(&url(app), Some(&dev)), "{app} should be refused");
        }
    }

    #[test]
    fn the_web_and_the_users_dev_servers_stay_open() {
        let dev = url("http://127.0.0.1:5175/");
        for page in [
            "https://example.com/",
            "http://localhost:5173/",
            "http://127.0.0.1:3000/",
            "http://127.0.0.1:5176/",
            "about:blank",
            "file:///C:/site/index.html",
            "data:text/html,hi",
        ] {
            assert!(allowed(&url(page), Some(&dev)), "{page} should open");
        }
        // Without a dev server, its address is just another local port.
        assert!(allowed(&url("http://127.0.0.1:5175/"), None));
    }

    /// A request for `url`, as the engine reports it. The destination is
    /// where the file would have gone, which the console shows as the name.
    fn requested<'a>(url: &str, destination: &'a mut PathBuf) -> DownloadEvent<'a> {
        DownloadEvent::Requested {
            url: Url::parse(url).unwrap(),
            destination,
        }
    }

    fn finished(url: &str, success: bool) -> DownloadEvent<'static> {
        DownloadEvent::Finished {
            url: Url::parse(url).unwrap(),
            path: None,
            success,
        }
    }

    /// A page must never be able to write a file into the user's Downloads
    /// folder by asking. One attempt is one row in the console's list: the
    /// attempt is reported as blocked, and the completion the engine may
    /// report for the operation it cancelled is not a second download. This
    /// pins the policy and the reporting together, so neither can drift.
    #[test]
    fn a_refused_download_is_one_row_whether_or_not_it_reports_a_finish() {
        let answer = page_may_download();
        let mut where_to = PathBuf::from("C:\\Users\\me\\Downloads\\a.zip");
        let mut downloads = Downloads::default();
        let attempt = downloads
            .reported(
                &requested("https://x.test/a.zip", &mut where_to),
                || 1,
                "tab-1",
                answer,
            )
            .expect("a request is reported");
        assert_eq!(
            (attempt.id, attempt.state, attempt.path.as_deref()),
            (1, "blocked", Some("C:\\Users\\me\\Downloads\\a.zip"))
        );
        assert!(
            downloads
                .reported(
                    &finished("https://x.test/a.zip", false),
                    || 2,
                    "tab-1",
                    answer
                )
                .is_none(),
            "a refused attempt's completion is not a second row"
        );
        // A second attempt is its own row, with its own id, rather than a
        // rewrite of the first one.
        let mut again_to = PathBuf::from("C:\\Users\\me\\Downloads\\b.zip");
        let again = downloads
            .reported(
                &requested("https://x.test/b.zip", &mut again_to),
                || 3,
                "tab-1",
                answer,
            )
            .expect("a request is reported");
        assert_eq!((again.id, again.state), (3, "blocked"));
    }

    /// A download the handler allows finishes the row its own request
    /// opened: the finish event carries the address and nothing else, and an
    /// id of its own would be a second row for one download. This is the
    /// path a build that lets the user ask for a file will take.
    #[test]
    fn an_allowed_download_finishes_the_row_its_request_opened() {
        let mut where_to = PathBuf::from("C:\\Users\\me\\Downloads\\a.zip");
        let mut downloads = Downloads::default();
        let started = downloads
            .reported(
                &requested("https://x.test/a.zip", &mut where_to),
                || 7,
                "tab-1",
                true,
            )
            .expect("a request is reported");
        assert_eq!((started.id, started.state), (7, "started"));
        let done = downloads
            .reported(&finished("https://x.test/a.zip", true), || 8, "tab-1", true)
            .expect("the finish of a started attempt is reported");
        assert_eq!((done.id, done.state), (7, "done"));
        // Nothing was started at this address, so there is no row to finish
        // and no row is invented for it.
        assert!(downloads
            .reported(
                &finished("https://x.test/other.zip", true),
                || 9,
                "tab-1",
                true
            )
            .is_none());
    }

    #[test]
    fn device_view_speaks_as_the_engines_android_build() {
        let desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
        assert_eq!(
            phone_agent(desktop),
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
        );
        assert_eq!(phone_agent("odd"), "");
    }

    /// The console decides what to draw from this, so the keys are the
    /// contract: one per control it can offer. A build that cannot do a
    /// feature must not claim it, or the console draws a control that fails
    /// silently - which is the whole point of asking the shell.
    #[test]
    fn this_build_says_which_browser_features_it_has() {
        let json = serde_json::to_value(browser_features()).unwrap();
        let mut keys: Vec<String> = json
            .as_object()
            .expect("an object of features")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            ["cdp", "clearSite", "devtools", "find", "print", "viewport"]
        );
        if !cfg!(windows) {
            // Printing is deliberately not in this list: wry has a real print
            // on every platform, so the flag stays true where these four are
            // false.
            for key in ["find", "cdp", "viewport", "clearSite"] {
                assert_eq!(json[key], serde_json::Value::Bool(false), "{key}");
            }
        }
    }

    /// The console sends one of these two strings with every DevTools call.
    /// The variants are what the shell branches on, so a rename on either
    /// side has to fail here: a wrong answer makes every element pick a
    /// deadline, which cancels the pick the user is still aiming at.
    #[test]
    fn the_console_wait_strings_are_this_builds_wait_variants() {
        assert!(matches!(
            serde_json::from_value::<Wait>(serde_json::json!("user")),
            Ok(Wait::User)
        ));
        assert!(matches!(
            serde_json::from_value::<Wait>(serde_json::json!("deadline")),
            Ok(Wait::Deadline)
        ));
    }
}
