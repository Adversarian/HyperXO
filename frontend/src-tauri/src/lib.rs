mod signaling;

const SIGNALING_PORT: u16 = 29170;

#[tauri::command]
fn get_signaling_info() -> std::collections::HashMap<String, String> {
    let mut info = std::collections::HashMap::new();
    info.insert("port".to_string(), SIGNALING_PORT.to_string());

    let ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    info.insert("ip".to_string(), ip);

    info
}

#[tauri::command]
fn create_room_cmd() -> Result<std::collections::HashMap<String, String>, String> {
    let url = format!("http://127.0.0.1:{}/api/room", SIGNALING_PORT);
    let body: serde_json::Value = ureq::post(&url)
        .send_empty()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())?;

    let room_id = body["roomId"].as_str().unwrap_or("").to_string();

    let ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let mut result = std::collections::HashMap::new();
    result.insert("roomId".to_string(), room_id.clone());
    result.insert(
        "joinUrl".to_string(),
        format!("http://{}:{}/?room={}", ip, SIGNALING_PORT, room_id),
    );
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
        rt.block_on(signaling::start_signaling_server(SIGNALING_PORT));
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![
            get_signaling_info,
            create_room_cmd
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
