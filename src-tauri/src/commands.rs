use crate::download::{Download, DownloadManager};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn add_download(
    state: State<'_, DownloadManager>,
    app: AppHandle,
    url: String,
    save_dir: String,
    filename: Option<String>,
    auto_start: bool,
    cookies: Option<String>,
    method: Option<String>,
    referer: Option<String>,
) -> Result<String, String> {
    let id = state.add_download(url, save_dir, filename, cookies, method, referer).await?;

    if auto_start {
        start_download_task(state.inner().clone(), id.clone(), app);
    }

    Ok(id)
}

#[tauri::command]
pub async fn start_queued_download(
    state: State<'_, DownloadManager>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    start_download_task(state.inner().clone(), id, app);
    Ok(())
}

fn start_download_task(manager: DownloadManager, download_id: String, app: AppHandle) {
    let app_handle = app.clone();
    let id = download_id.clone();

    tokio::spawn(async move {
        let result = manager
            .start_download(id.clone(), move |d: &Download| {
                let _ = app_handle.emit("download-progress", d.clone());
            })
            .await;

        if let Err(e) = result {
            let mut downloads = manager.downloads.lock().await;
            if let Some(d) = downloads.iter_mut().find(|d| d.id == id) {
                d.status = crate::download::DownloadStatus::Failed;
                d.error = Some(e.clone());
                let _ = app.emit("download-progress", d.clone());
            }
        }
    });
}

#[tauri::command]
pub async fn pause_download(state: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    state.pause_download(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn resume_download(state: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    state.resume_download(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn retry_download(
    state: State<'_, DownloadManager>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    state.reset_for_retry(&id).await?;
    start_download_task(state.inner().clone(), id, app);
    Ok(())
}

#[tauri::command]
pub async fn cancel_download(state: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    state.cancel_download(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn remove_download(state: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    state.remove_download(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn get_downloads(state: State<'_, DownloadManager>) -> Result<Vec<Download>, String> {
    Ok(state.get_all_downloads().await)
}

#[tauri::command]
pub async fn resolve_filename(
    state: State<'_, DownloadManager>,
    url: String,
) -> Result<(String, u64), String> {
    state.resolve_filename(&url).await
}

#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&path);
    let folder = if path.is_file() {
        path.parent().unwrap_or(&path).to_path_buf()
    } else {
        path
    };
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(folder.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(folder.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(folder.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_default_download_dir() -> Result<String, String> {
    dirs_next::download_dir()
        .or_else(dirs_next::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine download directory".to_string())
}
