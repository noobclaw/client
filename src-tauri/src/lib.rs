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

    let (mut _rx, child) = app
        .shell()
        .sidecar("noobclaw-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(&[port.to_string()])
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

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

            // Listen for deep link events (noobclaw://auth?token=xxx&wallet=xxx)
            let handle_for_deeplink = handle.clone();
            app.listen("deep-link://new-url", move |event| {
                if let Some(urls) = event.payload().as_str() {
                    for url in urls.split('\n') {
                        let url = url.trim();
                        if url.starts_with("noobclaw://auth") {
                            if let Ok(parsed) = url::Url::parse(url) {
                                let token = parsed.query_pairs()
                                    .find(|(k, _)| k == "token")
                                    .map(|(_, v)| v.to_string());
                                let wallet = parsed.query_pairs()
                                    .find(|(k, _)| k == "wallet")
                                    .map(|(_, v)| v.to_string());
                                if let (Some(t), Some(w)) = (token, wallet) {
                                    // Send auth callback to frontend via JS eval
                                    if let Some(window) = handle_for_deeplink.get_webview_window("main") {
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
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_server_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
