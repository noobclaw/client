use tauri::Manager;

/// Launch the Node.js sidecar server and return the port it's listening on.
fn start_sidecar(app: &tauri::AppHandle) -> Result<u16, String> {
    use tauri_plugin_shell::ShellExt;

    let port: u16 = 18800;

    let (mut _rx, _child) = app
        .shell()
        .sidecar("noobclaw-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(&[port.to_string()])
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    Ok(port)
}

#[tauri::command]
fn get_server_port(state: tauri::State<'_, ServerState>) -> u16 {
    state.port
}

struct ServerState {
    port: u16,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Start the Node.js sidecar
            let port = start_sidecar(&handle)
                .unwrap_or_else(|e| {
                    eprintln!("Sidecar start failed: {}", e);
                    18800 // fallback port
                });

            app.manage(ServerState { port });

            println!("NoobClaw Tauri started, sidecar on port {}", port);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_server_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
