use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;

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

    let (mut rx, child) = app
        .shell()
        .sidecar("noobclaw-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(&[port.to_string(), format!("--tauri-pid={}", tauri_pid)])
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Log sidecar output in background
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let s = String::from_utf8_lossy(&line);
                    if !s.trim().is_empty() {
                        println!("[sidecar] {}", s.trim());
                    }
                }
                CommandEvent::Stderr(line) => {
                    let s = String::from_utf8_lossy(&line);
                    if !s.trim().is_empty() {
                        eprintln!("[sidecar-err] {}", s.trim());
                    }
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[sidecar] Process terminated: {:?}", status);
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
        .invoke_handler(tauri::generate_handler![get_server_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
