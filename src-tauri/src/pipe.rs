use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserDownloadRequest {
    pub url: String,
    pub filename: Option<String>,
    pub filesize: Option<u64>,
    #[serde(default)]
    pub cookies: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub referer: Option<String>,
}

/// Listen on a Windows named pipe for download requests from the browser extension's native messaging host.
pub async fn start_pipe_listener(app: AppHandle) {
    loop {
        if let Err(e) = listen_once(&app).await {
            eprintln!("[pipe] Error: {}", e);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
}

#[cfg(windows)]
async fn listen_once(app: &AppHandle) -> Result<(), String> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = r"\\.\pipe\net-reaper";
    let server = ServerOptions::new()
        .first_pipe_instance(false)
        .create(pipe_name)
        .map_err(|e| format!("Failed to create pipe: {}", e))?;

    server
        .connect()
        .await
        .map_err(|e| format!("Pipe connect error: {}", e))?;

    let reader = BufReader::new(server);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(req) = serde_json::from_str::<BrowserDownloadRequest>(&line) {
            if !req.url.is_empty() {
                println!("[pipe] Received download: {}", req.url);
                let _ = app.emit("browser-download", req);

                // Bring window to front
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        }
    }

    Ok(())
}

#[cfg(not(windows))]
async fn listen_once(app: &AppHandle) -> Result<(), String> {
    use tokio::net::UnixListener;

    let sock_path = "/tmp/net-reaper.sock";
    let _ = std::fs::remove_file(sock_path);

    let listener = UnixListener::bind(sock_path)
        .map_err(|e| format!("Failed to bind socket: {}", e))?;

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Accept error: {}", e))?;

        let reader = BufReader::new(stream);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(req) = serde_json::from_str::<BrowserDownloadRequest>(&line) {
                if !req.url.is_empty() {
                    println!("[pipe] Received download: {}", req.url);
                    let _ = app.emit("browser-download", req);

                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        }
    }
}
