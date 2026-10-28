//! WebView2 specifics for the browser's tabs: the DevTools protocol
//! in-process, the browser's keys taken before the page sees them, and
//! history. Calls into WebView2 run on the window's thread (`with_webview`)
//! and answer back over a channel.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tauri::{AppHandle, Emitter, Webview};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Deferral, ICoreWebView2Environment15, ICoreWebView2Find,
    ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2PermissionRequestedEventArgs3,
    ICoreWebView2Profile2, ICoreWebView2_12, ICoreWebView2_13, ICoreWebView2_15, ICoreWebView2_16,
    ICoreWebView2_28, ICoreWebView2_3, COREWEBVIEW2_BROWSING_DATA_KINDS,
    COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE, COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE,
    COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE, COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES,
    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS,
    COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, COREWEBVIEW2_KEY_EVENT_KIND,
    COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE,
    COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION, COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
    COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
    COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
};
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    ClearBrowsingDataCompletedHandler, ContainsFullScreenElementChangedEventHandler,
    DevToolsProtocolEventReceivedEventHandler, FaviconChangedEventHandler,
    FindActiveMatchIndexChangedEventHandler, FindMatchCountChangedEventHandler,
    FindStartCompletedHandler, GetFaviconCompletedHandler, HistoryChangedEventHandler,
    PermissionRequestedEventHandler, StatusBarTextChangedEventHandler, TrySuspendCompletedHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

use super::{KeyPress, Wait};

/// The tabs' browser arguments. Every tab shares one WebView2 profile, and
/// WebView2 refuses a second set of arguments for a profile already open,
/// so every tab passes exactly these. They keep wry's own defaults (no
/// "mini menu", no PDF mini menu) and add one: a tab keeps running while
/// the window is hidden in the tray, where agents still browse. SmartScreen
/// stays on: a page's downloads are refused by the shell, and a file that
/// does reach the disk from this app is checked for reputation like any
/// other this machine opens.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI \
     --disable-backgrounding-occluded-windows";

/// Keys the browser takes while a page has focus, in the console's own
/// chord form (shortcuts.js). The browser's (Chrome's) and the app's
/// global ones; the console decides what each does.
const TAKEN: &[&str] = &[
    "Mod+T",
    "Mod+W",
    "Mod+L",
    "Mod+F",
    "Mod+R",
    "F5",
    "Mod+D",
    "Mod+H",
    "Mod+J",
    "Mod+Tab",
    "Mod+Shift+Tab",
    "Mod+Shift+T",
    "Mod+Shift+N",
    "Alt+Left",
    "Alt+Right",
    "F12",
    "Mod+K",
    "Mod+/",
    "Mod+N",
    "Mod+B",
    "Mod+,",
    "Mod+=",
    "Mod+-",
    "Mod+0",
];

/// A virtual key and the modifiers held, as a chord.
fn chord(vk: u32) -> Option<String> {
    let key = match vk {
        0x41..=0x5A | 0x30..=0x39 => char::from_u32(vk)?.to_string(),
        0x09 => "Tab".into(),
        0x25 => "Left".into(),
        0x27 => "Right".into(),
        0x26 => "Up".into(),
        0x28 => "Down".into(),
        0x70..=0x7B => format!("F{}", vk - 0x6F),
        0xBF => "/".into(),
        0xBC => ",".into(),
        0xDC => "\\".into(),
        0xBB => "=".into(),
        0xBD => "-".into(),
        _ => return None,
    };
    // SAFETY: GetKeyState only reads this thread's keyboard state.
    let held = |vk: u16| unsafe { GetKeyState(vk as i32) } < 0;
    let mut parts = Vec::new();
    if held(VK_CONTROL.0) {
        parts.push("Mod");
    }
    if held(VK_MENU.0) {
        parts.push("Alt");
    }
    if held(VK_SHIFT.0) {
        parts.push("Shift");
    }
    let mut chord = parts.join("+");
    if !chord.is_empty() {
        chord.push('+');
    }
    chord.push_str(&key);
    Some(chord)
}

/// Turn the engine's own context menu off for one webview.
///
/// A page's menu is worth having (copy, select all, back, reload), so tabs
/// keep it; the console's window is different. Every control that acts on the
/// console is the app's own, and the engine's menu offers actions the app
/// never had: "Save page as" writes a file from a page, which is the thing
/// the browser's download policy exists to prevent in the tabs, and "Reload"
/// reloads a webview the tab store is tracking. It is also an unthemed,
/// English, native menu in a window that draws its own chrome. A dev build
/// loses the menu's Inspect entry; the console's DevTools port (main.rs) is
/// the inspecting path there, not the menu.
pub fn no_default_menu(webview: &Webview) {
    let _ = webview.with_webview(|platform| {
        // SAFETY: COM calls on the window's thread, where the controller
        // lives; the settings object is created by the engine for it.
        unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                if let Ok(settings) = core.Settings() {
                    let _ = settings.SetAreDefaultContextMenusEnabled(false);
                }
            }
        }
    });
}

/// Hook a new tab: its browser keys go to the console.
pub fn attach(app: &AppHandle, webview: &Webview) {
    let app = app.clone();
    let tab = webview.label().to_string();
    let (page_app, page_tab) = (app.clone(), tab.clone());
    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            let mut vk = 0u32;
            // SAFETY: plain getters on the event's arguments.
            unsafe {
                args.KeyEventKind(&mut kind)?;
                args.VirtualKey(&mut vk)?;
            }
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
            {
                return Ok(());
            }
            if let Some(chord) = chord(vk).filter(|c| TAKEN.contains(&c.as_str())) {
                // SAFETY: as above.
                unsafe { args.SetHandled(true)? };
                let _ = app.emit_to(
                    super::console(),
                    "browser:key",
                    KeyPress {
                        tab: tab.clone(),
                        chord,
                    },
                );
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the controller outlives the handler's registration.
        unsafe {
            let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
        }
        // SAFETY: COM calls on the window's thread; each handler owns what
        // it touches.
        unsafe {
            if let Ok(core) = controller.CoreWebView2() {
                watch_page(&core, &page_app, &page_tab);
            }
        }
    });
}

/// What the toolbar and tab strip show about a page: whether back and
/// forward go anywhere, its icon, and the address of a link under the
/// pointer.
///
/// # Safety
/// Call on the window's thread.
unsafe fn watch_page(core: &ICoreWebView2, app: &AppHandle, tab: &str) {
    let mut token = 0i64;
    let (a, t) = (app.clone(), tab.to_string());
    let history = HistoryChangedEventHandler::create(Box::new(move |core, _| {
        let Some(core) = core else {
            return Ok(());
        };
        let (mut back, mut forward) = (BOOL::default(), BOOL::default());
        // SAFETY: plain getters on the window's thread.
        unsafe {
            core.CanGoBack(&mut back)?;
            core.CanGoForward(&mut forward)?;
        }
        super::update(&a, &t, |tab| {
            tab.can_back = back.as_bool();
            tab.can_forward = forward.as_bool();
        });
        Ok(())
    }));
    let _ = unsafe { core.add_HistoryChanged(&history, &mut token) };

    if let Ok(core15) = core.cast::<ICoreWebView2_15>() {
        let (a, t) = (app.clone(), tab.to_string());
        let favicon = FaviconChangedEventHandler::create(Box::new(move |core, _| {
            let Some(core) = core.and_then(|c| c.cast::<ICoreWebView2_15>().ok()) else {
                return Ok(());
            };
            let (a, t) = (a.clone(), t.clone());
            let done = GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
                let icon = result
                    .ok()
                    .and(stream)
                    .and_then(|stream| read_stream(&stream))
                    .filter(|png| !png.is_empty())
                    .map(|png| format!("data:image/png;base64,{}", BASE64.encode(png)));
                super::update(&a, &t, |tab| tab.favicon = icon);
                Ok(())
            }));
            // SAFETY: on the window's thread.
            unsafe { core.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &done) }
        }));
        let _ = unsafe { core15.add_FaviconChanged(&favicon, &mut token) };
    }

    if let Ok(core12) = core.cast::<ICoreWebView2_12>() {
        let (a, t) = (app.clone(), tab.to_string());
        let status = StatusBarTextChangedEventHandler::create(Box::new(move |core, _| {
            let Some(core) = core.and_then(|c| c.cast::<ICoreWebView2_12>().ok()) else {
                return Ok(());
            };
            let mut text = PWSTR::null();
            // SAFETY: on the window's thread; take_pwstr frees the string.
            unsafe { core.StatusBarText(&mut text)? };
            let text = take_pwstr(text);
            let _ = a.emit_to(
                super::console(),
                "browser:status",
                Status {
                    tab: t.clone(),
                    text,
                },
            );
            Ok(())
        }));
        let _ = unsafe { core12.add_StatusBarTextChanged(&status, &mut token) };
    }
}

/// A link's address under the pointer (empty when it leaves).
#[derive(Clone, serde::Serialize)]
struct Status {
    tab: String,
    text: String,
}

/// Find-in-page matches.
#[derive(Clone, serde::Serialize)]
struct FindState {
    tab: String,
    count: i32,
    active: i32,
}

/// The whole of a small stream (a favicon), or None past 1 MB.
fn read_stream(stream: &IStream) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    // SAFETY: reads into a buffer this function owns.
    unsafe {
        stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
        loop {
            let mut read = 0u32;
            if stream
                .Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read))
                .is_err()
            {
                return None;
            }
            if read == 0 {
                return Some(out);
            }
            out.extend_from_slice(&buf[..read as usize]);
            if out.len() > 1 << 20 {
                return None;
            }
        }
    }
}

/// The term each tab is searching for, so a repeat steps instead of
/// starting over; and the tabs whose match counts are already watched.
static FINDING: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn find(app: &AppHandle, webview: &Webview, term: String, step: i32) -> Result<(), String> {
    let (app, tab) = (app.clone(), webview.label().to_string());
    webview
        .with_webview(move |platform| {
            // SAFETY: COM calls on the window's thread.
            unsafe {
                let Ok(core) = platform.controller().CoreWebView2() else {
                    return;
                };
                let Ok(find) = core.cast::<ICoreWebView2_28>().and_then(|c| c.Find()) else {
                    return;
                };
                let mut finding = FINDING.lock().expect("find lock");
                let terms = finding.get_or_insert_with(HashMap::new);
                if term.is_empty() {
                    terms.remove(&tab);
                    let _ = find.Stop();
                    return;
                }
                let watched = terms.contains_key(&tab);
                if terms.get(&tab) == Some(&term) && step != 0 {
                    let _ = if step < 0 {
                        find.FindPrevious()
                    } else {
                        find.FindNext()
                    };
                    return;
                }
                terms.insert(tab.clone(), term.clone());
                drop(finding);
                if !watched {
                    let mut token = 0i64;
                    let report = |app: AppHandle, tab: String| {
                        move |find: Option<ICoreWebView2Find>, _| {
                            if let Some(find) = find {
                                let (mut count, mut active) = (0, 0);
                                let _ = find.MatchCount(&mut count);
                                let _ = find.ActiveMatchIndex(&mut active);
                                let _ = app.emit_to(
                                    super::console(),
                                    "browser:find",
                                    FindState {
                                        tab: tab.clone(),
                                        count,
                                        active,
                                    },
                                );
                            }
                            Ok(())
                        }
                    };
                    let _ = find.add_MatchCountChanged(
                        &FindMatchCountChangedEventHandler::create(Box::new(report(
                            app.clone(),
                            tab.clone(),
                        ))),
                        &mut token,
                    );
                    let _ = find.add_ActiveMatchIndexChanged(
                        &FindActiveMatchIndexChangedEventHandler::create(Box::new(report(
                            app.clone(),
                            tab.clone(),
                        ))),
                        &mut token,
                    );
                }
                let Ok(options) = platform
                    .environment()
                    .cast::<ICoreWebView2Environment15>()
                    .and_then(|env| env.CreateFindOptions())
                else {
                    return;
                };
                let _ = options.SetFindTerm(&HSTRING::from(term));
                let _ = options.SetShouldHighlightAllMatches(true);
                let _ = options.SetSuppressDefaultFindDialog(true);
                let _ = find.Start(
                    &options,
                    &FindStartCompletedHandler::create(Box::new(|_| Ok(()))),
                );
            }
        })
        .map_err(|e| e.to_string())
}

pub fn stop(webview: &Webview) -> Result<(), String> {
    webview
        .with_webview(|platform| {
            // SAFETY: COM calls on the window's thread.
            unsafe {
                if let Ok(core) = platform.controller().CoreWebView2() {
                    let _ = core.Stop();
                }
            }
        })
        .map_err(|e| e.to_string())
}

pub fn print(webview: &Webview) -> Result<(), String> {
    webview
        .with_webview(|platform| {
            // SAFETY: COM calls on the window's thread.
            unsafe {
                if let Ok(core) = platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|c| c.cast::<ICoreWebView2_16>())
                {
                    let _ = core.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER);
                }
            }
        })
        .map_err(|e| e.to_string())
}

/// How long a DevTools call the console asks a question with waits for the
/// page to answer. The expression such a call evaluates runs in the page's
/// own realm, and a page can hold one forever: a dialog open, its own
/// Promise or timers replaced, a long synchronous task. Without a deadline
/// the console waits for the life of the tab - the screenshot a menu needs
/// never arrives and the pane answers nothing again - so these calls get
/// one. It is the only timer in the module.
///
/// It is deliberately not a timer on every call: some calls are not the
/// console asking the page anything, they are the console waiting for the
/// person. An element pick is one of those, so it takes no deadline at all
/// (`Wait::User`): a pick is supposed to last as long as its human, and a
/// timer that ends it is a bug, not a bound. Both kinds are named by the
/// caller, so no call can inherit the wrong one by accident.
const ANSWER_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// A DevTools call's answer, or why there is none. `wait` is how long the
/// console is willing to wait, or none when the answer is the person's to
/// give: then only the page answering or its tab closing ends the wait.
fn wait_for_answer(
    answers: std::sync::mpsc::Receiver<Result<String, String>>,
    wait: Option<std::time::Duration>,
) -> Result<String, String> {
    match wait {
        Some(wait) => match answers.recv_timeout(wait) {
            Ok(answer) => answer,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                Err("the page did not answer in time".into())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("the tab did not answer".into())
            }
        },
        None => answers
            .recv()
            .map_err(|_| "the tab did not answer".to_string())?,
    }
}

/// One DevTools protocol call, answered as JSON. `wait` says which of the
/// two waits this call gets: a question the console needs an answer to, or
/// one the person answers in their own time.
pub async fn cdp(
    webview: &Webview,
    method: &str,
    params: serde_json::Value,
    wait: Wait,
) -> Result<serde_json::Value, String> {
    let deadline = match wait {
        Wait::Deadline => Some(ANSWER_WAIT),
        Wait::User => None,
    };
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let (method, params) = (method.to_string(), params.to_string());
    webview
        .with_webview(move |platform| {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |result, json| {
                    let _ = tx.send(result.map(|()| json).map_err(|e| e.message()));
                    Ok(())
                },
            ));
            // SAFETY: COM calls on the window's thread, where with_webview
            // runs; the handler owns everything it touches. If the call
            // fails the handler is dropped and the caller hears so.
            unsafe {
                if let Ok(core) = platform.controller().CoreWebView2() {
                    let _ = core.CallDevToolsProtocolMethod(
                        &HSTRING::from(method),
                        &HSTRING::from(params),
                        &handler,
                    );
                }
            }
        })
        .map_err(|e| e.to_string())?;
    // Waiting out the deadline parks a thread, so it happens off the async
    // workers rather than stalling one of them for as long as the page (or
    // the person) likes.
    let waited = tauri::async_runtime::spawn_blocking(move || wait_for_answer(rx, deadline))
        .await
        .map_err(|e| e.to_string())?;
    let json = waited?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

/// Hear one DevTools protocol event of a tab (its domain must be enabled
/// with a call for most events to flow). Runs `handler` on the window's
/// thread with the event's parameters.
pub fn on_event(
    webview: &Webview,
    event: &'static str,
    handler: impl Fn(serde_json::Value) + Send + 'static,
) -> Result<(), String> {
    webview
        .with_webview(move |platform| {
            // SAFETY: COM calls on the window's thread; the handler owns
            // what it touches.
            unsafe {
                let Ok(core) = platform.controller().CoreWebView2() else {
                    return;
                };
                let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event))
                else {
                    return;
                };
                let heard =
                    DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut json = PWSTR::null();
                        args.ParameterObjectAsJson(&mut json)?;
                        if let Ok(value) = serde_json::from_str(&take_pwstr(json)) {
                            handler(value);
                        }
                        Ok(())
                    }));
                let mut token = 0i64;
                let _ = receiver.add_DevToolsProtocolEventReceived(&heard, &mut token);
            }
        })
        .map_err(|e| e.to_string())
}

/// A site's request for a permission, waiting for the user's answer. The
/// request's objects belong to the window's thread, so they wait there.
struct Asking {
    args: ICoreWebView2PermissionRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
}

thread_local! {
    static ASKING: std::cell::RefCell<HashMap<u64, Asking>> = std::cell::RefCell::new(HashMap::new());
}

static ASKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// What a site asked for, in the console's words.
fn permission_kind(kind: COREWEBVIEW2_PERMISSION_KIND) -> &'static str {
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => "camera",
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "microphone",
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "geolocation",
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "notifications",
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "clipboard-read",
        COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => "midi",
        COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS => "downloads",
        COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS => "fonts",
        COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT => "window-management",
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE => "files",
        _ => "other",
    }
}

/// A site's permission request, as the console shows it.
#[derive(Clone, serde::Serialize)]
pub struct PermissionAsk {
    pub tab: String,
    pub id: u64,
    pub origin: String,
    pub kind: &'static str,
    pub label: String,
}

/// Hook what a page asks of the browser itself: permissions (held until
/// the user answers in the console; denied when nobody does) and going
/// fullscreen.
pub fn watch_requests(app: &AppHandle, webview: &Webview) {
    let (app, tab) = (app.clone(), webview.label().to_string());
    let _ = webview.with_webview(move |platform| {
        // SAFETY: COM calls on the window's thread; each handler owns what
        // it touches.
        unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let (a, t) = (app.clone(), tab.clone());
            let asked = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut uri = PWSTR::null();
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.Uri(&mut uri)?;
                args.PermissionKind(&mut kind)?;
                let uri = take_pwstr(uri);
                let origin = tauri::Url::parse(&uri)
                    .map(|u| u.origin().ascii_serialization())
                    .unwrap_or(uri);
                // The answer is the user's, per request: WebView2 keeps none.
                if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    let _ = args3.SetSavesInProfile(false);
                }
                let deferral = args.GetDeferral()?;
                let id = ASKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                ASKING.with(|asking| {
                    asking.borrow_mut().insert(id, Asking { args, deferral });
                });
                let kind = permission_kind(kind);
                let _ = a.emit_to(
                    super::console(),
                    "browser:permission",
                    PermissionAsk {
                        tab: t.clone(),
                        id,
                        label: origin.clone(),
                        origin,
                        kind,
                    },
                );
                // Unanswered requests are refused, so a page never waits
                // forever on a question nobody saw.
                let (a, t) = (a.clone(), t.clone());
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    if let Some(webview) = tauri::Manager::get_webview(&a, &t) {
                        let _ = answer_permission(&webview, id, false);
                    }
                });
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_PermissionRequested(&asked, &mut token);

            let (a, t) = (app.clone(), tab.clone());
            let fullscreen =
                ContainsFullScreenElementChangedEventHandler::create(Box::new(move |core, _| {
                    let Some(core) = core else {
                        return Ok(());
                    };
                    let mut on = BOOL::default();
                    core.ContainsFullScreenElement(&mut on)?;
                    let on = on.as_bool();
                    super::fullscreen_changed(&a, &t, on);
                    Ok(())
                }));
            let _ = core.add_ContainsFullScreenElementChanged(&fullscreen, &mut token);
        }
    });
}

/// The user's answer to a site's permission request.
pub fn answer_permission(webview: &Webview, id: u64, allow: bool) -> Result<(), String> {
    webview
        .with_webview(move |_| {
            let Some(asking) = ASKING.with(|asking| asking.borrow_mut().remove(&id)) else {
                return;
            };
            let state = if allow {
                COREWEBVIEW2_PERMISSION_STATE_ALLOW
            } else {
                COREWEBVIEW2_PERMISSION_STATE_DENY
            };
            // SAFETY: on the window's thread, where the request waits.
            unsafe {
                let _ = asking.args.SetState(state);
                let _ = asking.deferral.Complete();
            }
        })
        .map_err(|e| e.to_string())
}

/// Let a tab nobody is looking at sleep (its scripts and timers pause and
/// memory is freed until it's shown or used again).
pub fn suspend(webview: &Webview) -> Result<(), String> {
    webview
        .with_webview(|platform| {
            // SAFETY: COM calls on the window's thread.
            unsafe {
                if let Ok(core) = platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|c| c.cast::<ICoreWebView2_3>())
                {
                    let _ = core
                        .TrySuspend(&TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(()))));
                }
            }
        })
        .map_err(|e| e.to_string())
}

pub fn resume(webview: &Webview) -> Result<(), String> {
    webview
        .with_webview(|platform| {
            // SAFETY: COM calls on the window's thread.
            unsafe {
                if let Ok(core) = platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|c| c.cast::<ICoreWebView2_3>())
                {
                    let _ = core.Resume();
                }
            }
        })
        .map_err(|e| e.to_string())
}

/// Clear the browser profile's data (every tab shares it): any of
/// "cookies", "cache", "storage", or "all".
pub async fn clear_data(webview: &Webview, kinds: &[String]) -> Result<(), String> {
    let mut flags = 0i32;
    for kind in kinds {
        flags |= match kind.as_str() {
            "cookies" => COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES.0,
            "cache" => {
                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0
                    | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0
            }
            "storage" => {
                COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE.0
                    | COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS.0
            }
            "all" => COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE.0,
            other => return Err(format!("'{other}' is not cookies, cache, storage or all")),
        };
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    webview
        .with_webview(move |platform| {
            // SAFETY: COM calls on the window's thread; the handler owns the
            // sender.
            unsafe {
                let profile = platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|c| c.cast::<ICoreWebView2_13>())
                    .and_then(|c| c.Profile())
                    .and_then(|p| p.cast::<ICoreWebView2Profile2>());
                match profile {
                    Ok(profile) => {
                        let done =
                            ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                                let _ = tx.send(result.map_err(|e| e.message()));
                                Ok(())
                            }));
                        let _ = profile
                            .ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS(flags), &done);
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.message()));
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "the browser did not answer".to_string())?
}

/// Back or forward one page in the tab's own history.
pub fn history(webview: &Webview, step: i32) -> Result<(), String> {
    webview
        .with_webview(move |platform| {
            // SAFETY: COM calls on the window's thread.
            unsafe {
                if let Ok(core) = platform.controller().CoreWebView2() {
                    let _ = if step < 0 {
                        core.GoBack()
                    } else {
                        core.GoForward()
                    };
                }
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver};
    use std::time::Duration;

    /// A page that never settles the promise it is waiting on leaves the
    /// call unanswered: the wait has to end by itself, with an error the
    /// console can show, instead of holding the call until the tab closes.
    /// The sender stays open here, so this is a deadline and not a closed
    /// channel.
    #[test]
    fn a_page_that_never_answers_is_given_up_on() {
        let (_tx, rx): (_, Receiver<Result<String, String>>) = channel();
        assert_eq!(
            wait_for_answer(rx, Some(Duration::from_millis(20))),
            Err("the page did not answer in time".to_string())
        );
    }

    #[test]
    fn an_answer_that_comes_back_is_the_answer_itself() {
        let (tx, rx) = channel();
        tx.send(Ok("{\"id\":1}".to_string())).unwrap();
        assert_eq!(
            wait_for_answer(rx, Some(Duration::from_millis(20))),
            Ok("{\"id\":1}".to_string())
        );
        let (tx, rx) = channel();
        tx.send(Err("the method is gone".to_string())).unwrap();
        assert_eq!(
            wait_for_answer(rx, Some(Duration::from_millis(20))),
            Err("the method is gone".to_string())
        );
    }

    /// A pick is a person aiming, not a page that has stopped answering. The
    /// same late answer that a timed call gives up on is the answer for a
    /// pick, because a pick's wait has no deadline to reach - the whole
    /// point of telling the two waits apart.
    #[test]
    fn a_pick_is_waited_out_while_a_question_is_given_up_on() {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            let _ = tx.send(Ok("{\"result\":{\"value\":null}}".to_string()));
        });
        assert_eq!(
            wait_for_answer(rx, Some(Duration::from_millis(20))),
            Err("the page did not answer in time".to_string())
        );
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            let _ = tx.send(Ok("{\"result\":{\"value\":null}}".to_string()));
        });
        assert_eq!(
            wait_for_answer(rx, None),
            Ok("{\"result\":{\"value\":null}}".to_string())
        );
    }

    /// A tab that goes away while a pick is waiting still ends the wait: the
    /// page's answer can never arrive, and the console hears why instead of
    /// waiting for the rest of the session.
    #[test]
    fn a_picks_wait_ends_when_its_tab_goes() {
        let (tx, rx): (_, Receiver<Result<String, String>>) = channel();
        drop(tx);
        assert_eq!(
            wait_for_answer(rx, None),
            Err("the tab did not answer".to_string())
        );
    }
}
