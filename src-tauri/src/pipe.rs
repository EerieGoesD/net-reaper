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
    #[serde(default, rename = "userAgent")]
    pub user_agent: Option<String>,
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
    use std::ffi::c_void;
    use tokio::net::windows::named_pipe::ServerOptions;
    use windows_sys::Win32::Security::{
        InitializeSecurityDescriptor, SetSecurityDescriptorDacl, PSECURITY_DESCRIPTOR,
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
    };

    // Without a custom security descriptor, an MSIX-packaged app creates the
    // pipe with an AppContainer-restricted DACL that denies the Native Messaging
    // Host (launched by Chrome outside the container) when it tries to connect.
    // A NULL DACL grants access to all local processes, which is what we want
    // for this local-only IPC channel.
    let mut sd: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let psd: PSECURITY_DESCRIPTOR = &mut sd as *mut _ as *mut c_void;
    unsafe {
        if InitializeSecurityDescriptor(psd, 1) == 0 {
            return Err("InitializeSecurityDescriptor failed".to_string());
        }
        if SetSecurityDescriptorDacl(psd, 1, std::ptr::null_mut(), 0) == 0 {
            return Err("SetSecurityDescriptorDacl failed".to_string());
        }
    }
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd,
        bInheritHandle: 0,
    };

    let pipe_name = r"\\.\pipe\net-reaper";
    let server = unsafe {
        ServerOptions::new()
            .first_pipe_instance(false)
            .create_with_security_attributes_raw(pipe_name, &mut sa as *mut _ as *mut c_void)
    }
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
