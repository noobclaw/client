use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
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
        .setup(|app| {
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
        .invoke_handler(tauri::generate_handler![get_server_port, get_sidecar_log_tail])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
