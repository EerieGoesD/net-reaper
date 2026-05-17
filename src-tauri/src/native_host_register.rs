// Auto-registers the native messaging host so the browser extension
// can communicate with Net Reaper without any manual setup.

use std::path::PathBuf;

const HOST_NAME: &str = "com.eerie.net_reaper";

const ALLOWED_ORIGINS: &[&str] = &[
    "chrome-extension://cefbbgepiagenbdbbolghckaogmffpac/", // dev/unpacked ID
    "chrome-extension://kdojofdpfemlpcelbdbgcpkmjhememnb/", // Chrome Web Store ID
];

/// Get the path to the bundled native host binary (sitting next to the main app exe).
/// On MSIX installs this resolves to `C:\Program Files\WindowsApps\...` which Chrome/Brave
/// CANNOT successfully launch as a native messaging host, so this path is only used as the
/// COPY SOURCE; the registered manifest must point at the deployed copy under LOCALAPPDATA.
fn bundled_host_exe_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    #[cfg(windows)]
    let host = dir.join("net-reaper-host.exe");
    #[cfg(not(windows))]
    let host = dir.join("net-reaper-host");
    Some(host)
}

/// Directory where we deploy a user-writable copy of the host EXE and the manifest JSON.
fn deploy_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("LOCALAPPDATA").ok()?;
        Some(PathBuf::from(appdata).join("Net Reaper"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(&home).join("Library/Application Support/Google/Chrome/NativeMessagingHosts"))
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(&home).join(".config/google-chrome/NativeMessagingHosts"))
    }
}

fn manifest_path(dir: &PathBuf) -> PathBuf {
    dir.join(format!("{}.json", HOST_NAME))
}

#[cfg(windows)]
fn deployed_host_path(dir: &PathBuf) -> PathBuf {
    dir.join("net-reaper-host.exe")
}

#[cfg(not(windows))]
fn deployed_host_path(dir: &PathBuf) -> PathBuf {
    dir.join("net-reaper-host")
}

/// Copy the bundled host EXE into the user-writable deploy dir. We do this on every
/// startup so an MSIX upgrade gets picked up automatically. Skipped if the bundled
/// path and the deployed path are the same file (non-MSIX dev runs).
fn deploy_host(bundled: &PathBuf, deployed: &PathBuf) -> Result<(), String> {
    if let Some(parent) = deployed.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create deploy dir: {}", e))?;
    }
    if bundled == deployed {
        return Ok(());
    }
    std::fs::copy(bundled, deployed)
        .map(|_| ())
        .map_err(|e| format!("Failed to copy host exe: {}", e))
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
    let bundled = match bundled_host_exe_path() {
        Some(p) => p,
        None => {
            eprintln!("[native-host] Could not determine bundled host exe path");
            return;
        }
    };

    if !bundled.exists() {
        eprintln!("[native-host] Bundled host binary not found at: {}", bundled.display());
        return;
    }

    let dir = match deploy_dir() {
        Some(p) => p,
        None => {
            eprintln!("[native-host] Could not determine deploy dir");
            return;
        }
    };

    let deployed = deployed_host_path(&dir);
    if let Err(e) = deploy_host(&bundled, &deployed) {
        eprintln!("[native-host] {}", e);
        return;
    }

    let manifest = manifest_path(&dir);
    if let Err(e) = write_manifest(&manifest, &deployed) {
        eprintln!("[native-host] {}", e);
        return;
    }

    if let Err(e) = register_in_registry(&manifest) {
        eprintln!("[native-host] Registry registration failed: {}", e);
        return;
    }

    println!("[native-host] Registered: {} -> {}", manifest.display(), deployed.display());
}
