use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

/// State holding the sidecar child process so we can kill it on exit.
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    port: u16,
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

            Ok(())
        })
        .on_event(|app: &tauri::AppHandle, event: tauri::RunEvent| {
            // Kill sidecar when Tauri exits
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            println!("Killing sidecar process...");
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_server_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
