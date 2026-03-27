mod commands;
mod download;
mod native_host_register;
mod pipe;

use download::DownloadManager;

pub fn run() {
    // Register native messaging host before starting the UI
    // so the browser extension can connect immediately
    native_host_register::register();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(DownloadManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::add_download,
            commands::start_queued_download,
            commands::pause_download,
            commands::resume_download,
            commands::retry_download,
            commands::cancel_download,
            commands::remove_download,
            commands::get_downloads,
            commands::resolve_filename,
            commands::get_default_download_dir,
            commands::show_in_folder,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
                rt.block_on(pipe::start_pipe_listener(handle));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
