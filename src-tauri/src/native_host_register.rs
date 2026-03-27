// Auto-registers the native messaging host so the browser extension
// can communicate with Net Reaper without any manual setup.

use std::path::PathBuf;

const HOST_NAME: &str = "com.eerie.net_reaper";

// TODO: update this with the real Chrome Web Store extension ID after publishing
const ALLOWED_ORIGINS: &[&str] = &[
    "chrome-extension://cefbbgepiagenbdbbolghckaogmffpac/", // dev/unpacked ID
    // "chrome-extension://REAL_STORE_ID_HERE/",            // Chrome Web Store ID (add after publishing)
];

/// Get the path to the native host binary (sitting next to the main app exe)
fn host_exe_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    #[cfg(windows)]
    let host = dir.join("net-reaper-host.exe");
    #[cfg(not(windows))]
    let host = dir.join("net-reaper-host");
    Some(host)
}

/// Get the path where the host manifest JSON should be written
fn manifest_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("LOCALAPPDATA").ok()?;
        let dir = PathBuf::from(appdata).join("Net Reaper");
        Some(dir.join(format!("{}.json", HOST_NAME)))
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").ok()?;
        #[cfg(target_os = "macos")]
        let dir = PathBuf::from(&home).join("Library/Application Support/Google/Chrome/NativeMessagingHosts");
        #[cfg(target_os = "linux")]
        let dir = PathBuf::from(&home).join(".config/google-chrome/NativeMessagingHosts");
        Some(dir.join(format!("{}.json", HOST_NAME)))
    }
}

/// Write the native messaging host manifest JSON
fn write_manifest(manifest_path: &PathBuf, host_exe: &PathBuf) -> Result<(), String> {
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create manifest dir: {}", e))?;
    }

    let host_path_escaped = host_exe
        .to_string_lossy()
        .replace('\\', "\\\\");

    let origins: Vec<String> = ALLOWED_ORIGINS
        .iter()
        .map(|o| format!("    \"{}\"", o))
        .collect();

    let manifest = format!(
        r#"{{
  "name": "{}",
  "description": "Net Reaper Download Manager - Native Messaging Host",
  "path": "{}",
  "type": "stdio",
  "allowed_origins": [
{}
  ]
}}"#,
        HOST_NAME,
        host_path_escaped,
        origins.join(",\n")
    );

    std::fs::write(manifest_path, manifest)
        .map_err(|e| format!("Failed to write manifest: {}", e))
}

/// Register the manifest path in the Windows registry for Chrome, Edge, and Brave
#[cfg(windows)]
fn register_in_registry(manifest_path: &PathBuf) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let manifest_str = manifest_path.to_string_lossy();
    let reg_paths = [
        format!(r"HKCU\Software\Google\Chrome\NativeMessagingHosts\{}", HOST_NAME),
        format!(r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\{}", HOST_NAME),
        format!(r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{}", HOST_NAME),
    ];

    for reg_path in &reg_paths {
        let _ = Command::new("reg")
            .args(["add", reg_path, "/ve", "/t", "REG_SZ", "/d", &manifest_str, "/f"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }

    Ok(())
}

#[cfg(not(windows))]
fn register_in_registry(_manifest_path: &PathBuf) -> Result<(), String> {
    // On macOS/Linux the manifest file location IS the registration
    Ok(())
}

/// Run the full registration process. Call this on app startup.
pub fn register() {
    let host_exe = match host_exe_path() {
        Some(p) => p,
        None => {
            eprintln!("[native-host] Could not determine host exe path");
            return;
        }
    };

    if !host_exe.exists() {
        eprintln!("[native-host] Host binary not found at: {}", host_exe.display());
        return;
    }

    let manifest = match manifest_path() {
        Some(p) => p,
        None => {
            eprintln!("[native-host] Could not determine manifest path");
            return;
        }
    };

    if let Err(e) = write_manifest(&manifest, &host_exe) {
        eprintln!("[native-host] {}", e);
        return;
    }

    if let Err(e) = register_in_registry(&manifest) {
        eprintln!("[native-host] Registry registration failed: {}", e);
        return;
    }

    println!("[native-host] Registered: {}", manifest.display());
}
