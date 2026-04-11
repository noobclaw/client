use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_shell::process::CommandChild;

// ─── macOS TCC bridge ────────────────────────────────────────────────
//
// The sidecar (noobclaw-server) is a separate Mach-O binary, so when it
// calls CGDisplayCreateImage or CGEventPost the TCC database attributes
// the request to `noobclaw-server` — NOT the main NoobClaw bundle — and
// the user finds NO "NoobClaw" row in System Settings → Privacy →
// Screen Recording / Accessibility. Solution: call the preflight
// functions from the MAIN Rust binary at startup so TCC registers the
// main bundle. Once the user toggles it on, everything inside the .app
// (including the sidecar) gains the permission too IF the sidecar is
// signed with the same team identifier, which it is in our CI.
//
// These are plain C functions linked from CoreGraphics /
// ApplicationServices — no objc2 crate needed.
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[tauri::command]
fn check_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return CGPreflightScreenCaptureAccess();
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn request_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return CGRequestScreenCaptureAccess();
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return AXIsProcessTrusted();
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn open_screen_recording_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

#[tauri::command]
fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

#[tauri::command]
fn open_microphone_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn();
    }
}

// ─── Dock badge (macOS) ──────────────────────────────────────────────
//
// Shows a small red indicator with optional text on the Dock icon —
// standard macOS pattern for "something is happening / pending count".
// Tauri v2.10.3 does not expose `set_badge_label` on WebviewWindow so
// we call NSApp.dockTile directly via the objc2 crate. Called from
// tauriShim whenever a cowork session starts/completes so the user
// sees a ● while an AI task is running even if the main window is
// hidden or the tray is overflowing.
//
// Windows/Linux: no-op. The renderer still calls the command on
// those platforms for simplicity; the target-cfg gate below makes
// the body compile to nothing.

#[tauri::command]
fn set_dock_badge(label: Option<String>) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        // NSApp.sharedApplication → NSApplication*
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() {
            return;
        }

        // NSApplication.dockTile → NSDockTile*
        let dock_tile: *mut AnyObject = msg_send![app, dockTile];
        if dock_tile.is_null() {
            return;
        }

        // Set or clear the label.
        match label.as_deref() {
            Some(text) if !text.is_empty() => {
                let ns = NSString::from_str(text);
                let _: () = msg_send![dock_tile, setBadgeLabel: &*ns];
            }
            _ => {
                let nil: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![dock_tile, setBadgeLabel: nil];
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = label; // unused on non-mac
    }
}

/// Resolve the on-disk log path for sidecar stdout/stderr capture.
/// - macOS: ~/Library/Application Support/NoobClaw/logs/sidecar.log
/// - Linux: ~/.noobclaw/logs/sidecar.log
/// - Windows: %APPDATA%/NoobClaw/logs/sidecar.log
///
/// Created unconditionally so the user (or we, via the /api/diagnostic
/// endpoint) can tail it after a failed startup.
fn sidecar_log_path() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        dirs::home_dir()?.join("Library/Application Support/NoobClaw")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("NoobClaw")
    } else {
        dirs::home_dir()?.join(".noobclaw")
    };
    let logs = base.join("logs");
    let _ = fs::create_dir_all(&logs);
    Some(logs.join("sidecar.log"))
}

/// Append a line to the sidecar log. Silent on failure — we never want
/// log plumbing to take down the app. Rotates when the file exceeds
/// ~512 KB by renaming the current file to `sidecar.log.1` and starting
/// fresh; we only keep one generation since the log is for diagnostics,
/// not audit.
const SIDECAR_LOG_MAX_BYTES: u64 = 512 * 1024;

fn append_sidecar_log(line: &str) {
    let Some(path) = sidecar_log_path() else { return };
    // Rotate if needed — cheap stat call, ignored on error.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > SIDECAR_LOG_MAX_BYTES {
            let rotated = path.with_extension("log.1");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(&path, &rotated);
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// State holding the sidecar child process so we can kill it on exit.
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    port: u16,
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                println!("Killing sidecar process on drop...");
                let _ = child.kill();
            }
        }
    }
}

/// Launch the Node.js sidecar server and return (port, child).
fn start_sidecar(app: &tauri::AppHandle) -> Result<(u16, CommandChild), String> {
    use tauri_plugin_shell::ShellExt;

    let port: u16 = 18800;
    // Tauri's real PID. Pass it explicitly so the sidecar can monitor the
    // correct process — `process.ppid` on Windows is unreliable because the
    // shell plugin may spawn us through an intermediate helper that exits
    // immediately, causing the sidecar's parent-watchdog to false-positive
    // and shut itself down mid-cowork-session.
    let tauri_pid = std::process::id();

    append_sidecar_log(&format!(
        "\n========== sidecar start (tauri_pid={} port={}) ==========",
        tauri_pid, port
    ));

    let spawn_result = app
        .shell()
        .sidecar("noobclaw-server")
        .map_err(|e| {
            let msg = format!("Failed to create sidecar command: {}", e);
            append_sidecar_log(&format!("[tauri] {}", msg));
            msg
        })?
        .args(&[port.to_string(), format!("--tauri-pid={}", tauri_pid)])
        .spawn();
    let (mut rx, child) = spawn_result.map_err(|e| {
        let msg = format!("Failed to spawn sidecar: {}", e);
        append_sidecar_log(&format!("[tauri] {}", msg));
        msg
    })?;

    // Log sidecar output in background — both to stdout (for `tauri dev`)
    // and to a persistent log file so packaged macOS users can diagnose
    // "sidecar unreachable" without a terminal attached.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let s = String::from_utf8_lossy(&line);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        println!("[sidecar] {}", trimmed);
                        append_sidecar_log(&format!("[out] {}", trimmed));
                    }
                }
                CommandEvent::Stderr(line) => {
                    let s = String::from_utf8_lossy(&line);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        eprintln!("[sidecar-err] {}", trimmed);
                        append_sidecar_log(&format!("[err] {}", trimmed));
                    }
                }
                CommandEvent::Terminated(status) => {
                    let msg = format!("[sidecar] Process terminated: {:?}", status);
                    eprintln!("{}", msg);
                    append_sidecar_log(&format!("[exit] {:?}", status));
                    break;
                }
                _ => {}
            }
        }
    });

    Ok((port, child))
}

#[tauri::command]
fn get_server_port(state: tauri::State<'_, SidecarState>) -> u16 {
    state.port
}

/// Return the last ~200 lines of the sidecar log as a single string.
/// Invoked from the renderer's health-banner fallback so the user can
/// see *why* the sidecar failed to start without opening a terminal.
#[tauri::command]
fn get_sidecar_log_tail() -> String {
    let Some(path) = sidecar_log_path() else {
        return String::from("(sidecar log path unavailable)");
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return format!("(no sidecar log at {})", path.display());
    };
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(200);
    lines[start..].join("\n")
}

// ─── Keychain token storage ──────────────────────────────────────────
//
// Historic behavior: the NoobClaw JWT auth token was persisted to the
// SQLite kv store as plaintext. That works but is not aligned with how
// native Mac apps store secrets, and it leaks the token to anyone who
// can read `~/Library/Application Support/NoobClaw/noobclaw.sqlite`.
// The keyring crate uses the macOS Security framework's Keychain
// Services under the hood, so tokens land in the login keychain where
// only this app bundle (codesigned with our identity) can read them.
//
// Semantics:
//   SERVICE = "com.noobclaw.desktop"       (matches bundle identifier)
//   ACCOUNT = "noobclaw-jwt"               (fixed, we only store one token)
//
// Called from the sidecar via the Tauri command bridge — see
// src/main/libs/claudeSettings.ts's keychain wrapper.

const KEYCHAIN_SERVICE: &str = "com.noobclaw.desktop";
const KEYCHAIN_ACCOUNT: &str = "noobclaw-jwt";

#[tauri::command]
fn keychain_set_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("keyring Entry::new failed: {}", e))?;
    entry
        .set_password(&token)
        .map_err(|e| format!("keychain write failed: {}", e))
}

#[tauri::command]
fn keychain_get_token() -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
    entry.get_password().ok()
}

#[tauri::command]
fn keychain_delete_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("keyring Entry::new failed: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Absent-item is not an error for delete semantics.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {}", e)),
    }
}

// ─── NSPanel-style command bar (spotlight clone) ─────────────────────
//
// A second Tauri WebviewWindow (label "command-bar") is declared in
// tauri.conf.json with decorations:false, transparent:true,
// alwaysOnTop:true, skipTaskbar:true. On macOS that's *almost* enough to
// get a Spotlight-style floating panel — the remaining problem is that
// Tauri backs the window with a plain NSWindow, not NSPanel, so it
// steals key-window focus from whatever the user was typing in, and it
// does NOT float above full-screen apps. The fix is to flip three bits
// on the underlying NSWindow using objc2:
//
//   1. setLevel: NSStatusWindowLevel (floats above regular windows)
//   2. setCollectionBehavior: CanJoinAllSpaces | FullScreenAuxiliary
//      (shows on every Space including full-screen apps)
//   3. setHidesOnDeactivate: YES  (auto-hides when user clicks away)
//
// NSPanel subclass swap is possible but requires IMP-swizzling which
// objc2 doesn't expose ergonomically; setting the three properties above
// gives 95% of the user-visible behavior for 5% of the code.
//
// Windows/Linux: skipped — the alwaysOnTop + decorations:false window is
// already pretty close to spotlight behavior on those platforms.

#[tauri::command]
fn show_command_bar(app: AppHandle) {
    let Some(window) = app.get_webview_window("command-bar") else {
        return;
    };

    // Re-center on the active screen before showing. The user may have
    // moved between monitors since last invocation.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let screen = monitor.size();
        let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize {
            width: 680,
            height: 60,
        });
        let x = (screen.width as i32 - win_size.width as i32) / 2;
        // Place ~22% down from the top — Spotlight's position.
        let y = (screen.height as f64 * 0.22) as i32;
        let _ = window.set_position(tauri::PhysicalPosition { x, y });
    }

    let _ = window.show();
    let _ = window.set_focus();

    // Elevate to panel-like behavior on macOS.
    #[cfg(target_os = "macos")]
    elevate_command_bar_to_panel(&window);
}

#[tauri::command]
fn hide_command_bar(app: AppHandle) {
    if let Some(window) = app.get_webview_window("command-bar") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn toggle_command_bar(app: AppHandle) {
    let Some(window) = app.get_webview_window("command-bar") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        let _ = window.hide();
    } else {
        show_command_bar(app);
    }
}

#[cfg(target_os = "macos")]
fn elevate_command_bar_to_panel(window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::msg_send;

    // NSStatusWindowLevel = 25, floats above regular app windows.
    const NS_STATUS_WINDOW_LEVEL: i64 = 25;
    // NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0
    // NSWindowCollectionBehaviorFullScreenAuxiliary = 1 << 8
    const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
    const FULL_SCREEN_AUX: u64 = 1 << 8;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window_ptr as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }

    unsafe {
        let _: () = msg_send![ns_window, setLevel: NS_STATUS_WINDOW_LEVEL];
        let behavior: u64 = CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUX;
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        // Auto-hide when user clicks away — Spotlight behavior.
        let _: () = msg_send![ns_window, setHidesOnDeactivate: true];
        // Make sure we sit above all app windows but do not steal
        // first-responder status from the app the user was in — the
        // webview's own input element will grab focus on mousedown.
        let _: () = msg_send![ns_window, orderFrontRegardless];
    }
}

// ─── Toggle main window visibility ───────────────────────────────────
// Shared helper used by the global-shortcut hotkey, the tray icon click,
// and the single-instance second-launch callback. Keeping one place for
// the show+focus sequence avoids subtle bugs where some paths focus but
// forget to unminimize etc.
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Handle a single `noobclaw://` deep link delivered either via argv
/// (Windows/Linux single-instance second launch) or via the macOS
/// `application:openURL:` Apple Event (tauri-plugin-deep-link's
/// `on_open_url` callback). macOS does NOT put the URL in argv, so
/// without this code path the existing app instance would silently
/// drop the auth redirect and the user's click would appear to "open
/// a new application" (the OS launching a fresh process because nobody
/// claimed the URL). Keep this function sync + side-effect-free aside
/// from the window.eval + focus, so both callers can reuse it.
fn handle_deep_link(app: &AppHandle, raw: &str) {
    if !raw.starts_with("noobclaw://") {
        return;
    }
    let Ok(parsed) = url::Url::parse(raw) else { return };
    if parsed.host_str() != Some("auth") {
        return;
    }
    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.to_string());
    let wallet = parsed
        .query_pairs()
        .find(|(k, _)| k == "wallet")
        .map(|(_, v)| v.to_string());
    let (Some(t), Some(w)) = (token, wallet) else { return };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let js = format!(
            "window.dispatchEvent(new CustomEvent('noobclaw-auth', {{detail: {{token: '{}', wallet: '{}'}}}}));",
            t.replace('\'', "\\'"),
            w.replace('\'', "\\'")
        );
        let _ = window.eval(&js);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Default global hotkey to summon the window: ⌥⌘N on macOS, Ctrl+Alt+N
    // everywhere else. Deliberately NOT ⌘Space (Spotlight) or ⌘Tab (app
    // switcher). Chosen to be unlikely to collide with Finder, browsers,
    // or VS Code keybindings.
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
    #[cfg(target_os = "macos")]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyN);
    #[cfg(not(target_os = "macos"))]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);

    // Spotlight-style command bar: ⌥⌘Space on macOS, Ctrl+Alt+Space on
    // Windows/Linux. Chosen so it does NOT clash with ⌘Space (Spotlight)
    // or Win+Space (Input language switcher). Toggles the command-bar
    // window's visibility via toggle_command_bar.
    #[cfg(target_os = "macos")]
    let command_bar_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::Space);
    #[cfg(not(target_os = "macos"))]
    let command_bar_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &toggle_shortcut {
                        toggle_main_window(app);
                    } else if shortcut == &command_bar_shortcut {
                        // Toggle the floating command bar. Same semantics
                        // as clicking the tray menu: show if hidden, hide
                        // if visible.
                        let cloned = app.clone();
                        toggle_command_bar(cloned);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Windows/Linux: second-instance launch delivers the deep link
            // via argv. macOS uses the on_open_url path below — never argv.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            for arg in args.iter() {
                handle_deep_link(app, arg);
            }
        }))
        .setup(move |app| {
            let handle = app.handle().clone();

            // Register the macOS deep-link listener. Without this, clicking
            // `noobclaw://auth?...` from the system browser never reaches
            // the running app — macOS would silently drop the URL (or, in
            // some launch paths, appear to spawn a duplicate process).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let dl_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&dl_handle, url.as_str());
                    }
                });
            }

            // ── Global shortcut registration ─────────────────────────
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register(toggle_shortcut) {
                    eprintln!("Failed to register toggle shortcut: {}", e);
                }
                if let Err(e) = app.global_shortcut().register(command_bar_shortcut) {
                    eprintln!("Failed to register command-bar shortcut: {}", e);
                }
            }

            // ── Command bar NSPanel elevation on startup ─────────────
            // The command-bar window is declared `visible:false` in
            // tauri.conf.json, but we still need to elevate it to panel
            // level so the first show is instant. Doing it here avoids
            // a visible window frame flash on the first ⌥⌘Space press.
            #[cfg(target_os = "macos")]
            {
                if let Some(cb) = app.get_webview_window("command-bar") {
                    elevate_command_bar_to_panel(&cb);
                    // Hide esc-hide behavior: close on ESC or focus loss.
                    // The renderer handles ESC; here we just ensure the
                    // window is actually hidden after the panel upgrade
                    // (setHidesOnDeactivate sometimes flashes it on startup).
                    let _ = cb.hide();
                }
            }

            // ── Dock menu (macOS) ─────────────────────────────────────
            // Right-click on the Dock icon shows a custom menu. Gives
            // users a quick path to "New Chat" without opening the main
            // window first. The menu is attached to the main AppHandle
            // via set_dock_menu on macOS.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::MenuBuilder;
                let dock_menu = MenuBuilder::new(app)
                    .text("dock_new_chat", "New Chat")
                    .text("dock_show", "Show Window")
                    .separator()
                    .text("dock_quit", "Quit NoobClaw")
                    .build()?;
                if let Err(e) = app.set_dock_menu(Some(dock_menu)) {
                    eprintln!("Failed to set dock menu: {}", e);
                }
            }

            // ── Drag & drop wiring (main window) ──────────────────────
            // Tauri v2 webviews have drag&drop enabled by default. The
            // Rust side sees DragDrop events on the main window; we
            // forward full file paths to the renderer as a custom
            // `nc://file-drop` JS event (the renderer listens for it
            // in tauriShim.ts and injects the files into the chat
            // composer). HTML5 drag&drop inside the webview only
            // exposes File blobs without real paths, so this native
            // path is strictly better for our "drag a PDF into chat"
            // use case.
            if let Some(window) = app.get_webview_window("main") {
                let win_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(drag) = event {
                        if let tauri::DragDropEvent::Drop { paths, .. } = drag {
                            let json_paths: Vec<String> = paths
                                .iter()
                                .filter_map(|p| p.to_str().map(|s| s.to_string()))
                                .collect();
                            // Build a single JS array literal and
                            // dispatch a CustomEvent the renderer can
                            // intercept.
                            let arr = serde_json::to_string(&json_paths)
                                .unwrap_or_else(|_| "[]".into());
                            let js = format!(
                                "window.dispatchEvent(new CustomEvent('nc://file-drop', {{detail: {{paths: {}}}}}));",
                                arr
                            );
                            let _ = win_clone.eval(&js);
                        }
                    }
                });
            }

            // ── Menubar tray icon ────────────────────────────────────
            // One menu: Show / Quit. Left-clicking the tray icon itself
            // toggles the main window visibility (same semantics as the
            // global hotkey). We use the default app icon for the tray
            // image on macOS the OS will automatically template it.
            {
                let show_item = MenuItem::with_id(
                    app,
                    "tray_show",
                    "Show NoobClaw",
                    true,
                    None::<&str>,
                )?;
                let quit_item = MenuItem::with_id(
                    app,
                    "tray_quit",
                    "Quit NoobClaw",
                    true,
                    None::<&str>,
                )?;
                let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                let _tray = TrayIconBuilder::with_id("main-tray")
                    .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                        // Fallback: empty 1x1 image if the default icon is
                        // somehow missing. Tray won't be visible but we
                        // avoid crashing.
                        tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1)
                    }))
                    .menu(&tray_menu)
                    .menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray_show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "tray_quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            toggle_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // ── macOS TCC priming ────────────────────────────────────
            // Force-register the main app binary with the TCC database
            // for Screen Recording and Accessibility so the user SEES
            // "NoobClaw" in System Settings → Privacy instead of having
            // to hunt for `noobclaw-server`. These two calls are
            // documented as "silent preflight" — they do NOT prompt the
            // user unless we also call the `Request` variant, which we
            // defer until the user actually needs the capability.
            #[cfg(target_os = "macos")]
            unsafe {
                let _ = CGPreflightScreenCaptureAccess();
                let _ = AXIsProcessTrusted();
            }

            // Start the Node.js sidecar
            match start_sidecar(&handle) {
                Ok((port, child)) => {
                    app.manage(SidecarState {
                        child: Mutex::new(Some(child)),
                        port,
                    });
                    println!("NoobClaw Tauri started, sidecar on port {}", port);
                }
                Err(e) => {
                    eprintln!("Sidecar start failed: {}", e);
                    app.manage(SidecarState {
                        child: Mutex::new(None),
                        port: 18800,
                    });
                }
            }

            // DevTools: only in debug builds (release builds use F12/Ctrl+Shift+I)
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            get_sidecar_log_tail,
            keychain_set_token,
            keychain_get_token,
            keychain_delete_token,
            show_main_window,
            check_screen_recording_permission,
            request_screen_recording_permission,
            check_accessibility_permission,
            open_screen_recording_settings,
            open_accessibility_settings,
            open_microphone_settings,
            set_dock_badge,
            show_command_bar,
            hide_command_bar,
            toggle_command_bar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
