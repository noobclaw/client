use std::sync::Mutex;
use tauri::Manager;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // When a second instance is launched, focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // If the second instance carried a deep link URL, handle it
            for arg in args.iter() {
                if arg.starts_with("noobclaw://") {
                    if let Ok(parsed) = url::Url::parse(arg) {
                        if parsed.host_str() == Some("auth") {
                            let token = parsed.query_pairs()
                                .find(|(k, _)| k == "token")
                                .map(|(_, v)| v.to_string());
                            let wallet = parsed.query_pairs()
                                .find(|(k, _)| k == "wallet")
                                .map(|(_, v)| v.to_string());
                            if let (Some(t), Some(w)) = (token, wallet) {
                                if let Some(window) = app.get_webview_window("main") {
                                    let js = format!(
                                        "window.dispatchEvent(new CustomEvent('noobclaw-auth', {{detail: {{token: '{}', wallet: '{}'}}}}));",
                                        t.replace('\'', "\\'"), w.replace('\'', "\\'")
                                    );
                                    let _ = window.eval(&js);
                                }
                            }
                        }
                    }
                }
            }
        }))
        .setup(|app| {
            let handle = app.handle().clone();

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
