use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

pub fn human_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 { return "0 B".to_string(); }
    let i = (bytes as f64).log(1024.0).floor() as usize;
    let i = i.min(UNITS.len() - 1);
    let val = bytes as f64 / 1024_f64.powi(i as i32);
    if i == 0 { format!("{} B", bytes) }
    else { format!("{:.1} {}", val, UNITS[i]) }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Download {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub save_path: String,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub status: DownloadStatus,
    pub speed_bps: u64,
    pub error: Option<String>,
    pub created_at: String,
}

impl Download {
    pub fn new(url: String, filename: String, save_path: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            url,
            filename,
            save_path,
            total_bytes: 0,
            downloaded_bytes: 0,
            status: DownloadStatus::Queued,
            speed_bps: 0,
            error: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

}

#[derive(Debug, Clone)]
pub struct DownloadManager {
    pub downloads: Arc<Mutex<Vec<Download>>>,
    client: Client,
    cancel_flags: Arc<Mutex<std::collections::HashMap<String, bool>>>,
    pause_flags: Arc<Mutex<std::collections::HashMap<String, bool>>>,
    request_cookies: Arc<Mutex<std::collections::HashMap<String, String>>>,
    request_methods: Arc<Mutex<std::collections::HashMap<String, String>>>,
    request_referers: Arc<Mutex<std::collections::HashMap<String, String>>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            downloads: Arc::new(Mutex::new(Vec::new())),
            client: Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
                .default_headers({
                    let mut h = reqwest::header::HeaderMap::new();
                    h.insert(reqwest::header::ACCEPT_ENCODING, "identity".parse().unwrap());
                    h.insert(reqwest::header::ACCEPT, "*/*".parse().unwrap());
                    h.insert(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9".parse().unwrap());
                    h.insert("Sec-Ch-Ua", "\"Chromium\";v=\"146\", \"Google Chrome\";v=\"146\", \"Not?A_Brand\";v=\"99\"".parse().unwrap());
                    h.insert("Sec-Ch-Ua-Mobile", "?0".parse().unwrap());
                    h.insert("Sec-Ch-Ua-Platform", "\"Windows\"".parse().unwrap());
                    h.insert("Sec-Fetch-Dest", "document".parse().unwrap());
                    h.insert("Sec-Fetch-Mode", "navigate".parse().unwrap());
                    h.insert("Sec-Fetch-Site", "none".parse().unwrap());
                    h.insert("Sec-Fetch-User", "?1".parse().unwrap());
                    h.insert("Upgrade-Insecure-Requests", "1".parse().unwrap());
                    h
                })
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_proxy()
                .tcp_keepalive(std::time::Duration::from_secs(30))
                .read_timeout(std::time::Duration::from_secs(120))
                .connect_timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Failed to build HTTP client"),
            cancel_flags: Arc::new(Mutex::new(std::collections::HashMap::new())),
            pause_flags: Arc::new(Mutex::new(std::collections::HashMap::new())),
            request_cookies: Arc::new(Mutex::new(std::collections::HashMap::new())),
            request_methods: Arc::new(Mutex::new(std::collections::HashMap::new())),
            request_referers: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// Resolve the filename from URL or Content-Disposition header
    pub async fn resolve_filename(&self, url: &str) -> Result<(String, u64), String> {
        let resp = self
            .client
            .head(url)
            .send()
            .await
            .map_err(|e| format!("HEAD request failed: {}", e))?;

        let content_length = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        // Try Content-Disposition header first
        let filename = resp
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.split("filename=")
                    .nth(1)
                    .map(|f| f.trim_matches('"').to_string())
            })
            .unwrap_or_else(|| {
                // Fall back to URL path, decode percent-encoding
                let raw = url.split('/')
                    .last()
                    .unwrap_or("download")
                    .split('?')
                    .next()
                    .unwrap_or("download");
                urlencoding::decode(raw)
                    .unwrap_or_else(|_| raw.into())
                    .into_owned()
            });

        Ok((filename, content_length))
    }

    /// Add a new download and return its ID
    pub async fn add_download(&self, url: String, save_dir: String, custom_filename: Option<String>, cookies: Option<String>, method: Option<String>, referer: Option<String>) -> Result<String, String> {
        let (resolved_name, total_bytes) = self.resolve_filename(&url).await.unwrap_or_else(|_| ("download".to_string(), 0));
        let filename = custom_filename
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(resolved_name);
        let save_path = PathBuf::from(&save_dir)
            .join(&filename)
            .to_string_lossy()
            .to_string();

        let mut download = Download::new(url, filename, save_path);
        download.total_bytes = total_bytes;
        let id = download.id.clone();

        {
            let mut downloads = self.downloads.lock().await;
            downloads.push(download);
        }
        {
            let mut flags = self.cancel_flags.lock().await;
            flags.insert(id.clone(), false);
        }
        {
            let mut flags = self.pause_flags.lock().await;
            flags.insert(id.clone(), false);
        }
        if let Some(c) = cookies {
            let mut cmap = self.request_cookies.lock().await;
            cmap.insert(id.clone(), c);
        }
        if let Some(m) = method {
            if m != "GET" {
                let mut mmap = self.request_methods.lock().await;
                mmap.insert(id.clone(), m);
            }
        }
        if let Some(r) = referer {
            let mut rmap = self.request_referers.lock().await;
            rmap.insert(id.clone(), r);
        }

        Ok(id)
    }

    /// Start downloading a file by ID
    pub async fn start_download<F>(&self, id: String, on_progress: F) -> Result<(), String>
    where
        F: Fn(&Download) + Send + 'static,
    {
        let download = {
            let downloads = self.downloads.lock().await;
            downloads
                .iter()
                .find(|d| d.id == id)
                .cloned()
                .ok_or("Download not found")?
        };

        // Update status to Downloading
        self.update_status(&id, DownloadStatus::Downloading).await;

        // Use POST if the browser extension detected a non-GET method
        let http_method = {
            let mmap = self.request_methods.lock().await;
            mmap.get(&id).cloned().unwrap_or_else(|| "GET".to_string())
        };

        // Build request with correct method
        let mut req = match http_method.as_str() {
            "POST" => self.client.post(&download.url),
            "PUT" => self.client.put(&download.url),
            _ => self.client.get(&download.url),
        };

        // Attach browser cookies if available (for Cloudflare-protected sites)
        {
            let cmap = self.request_cookies.lock().await;
            if let Some(cookies) = cmap.get(&id) {
                req = req.header("Cookie", cookies.as_str());
            }
        }
        // Attach referer if captured from the browser request
        {
            let rmap = self.request_referers.lock().await;
            if let Some(referer) = rmap.get(&id) {
                req = req.header("Referer", referer.as_str());
            }
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("{} request failed: {}", http_method, e))?;

        // Check HTTP status before streaming
        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();

            // Collect diagnostic headers
            let server = resp.headers().get("server")
                .and_then(|v| v.to_str().ok()).unwrap_or("unknown").to_string();
            let cf_ray = resp.headers().get("cf-ray")
                .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            let cf_cache = resp.headers().get("cf-cache-status")
                .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            let content_type = resp.headers().get("content-type")
                .and_then(|v| v.to_str().ok()).unwrap_or("unknown").to_string();

            // Read a snippet of the response body for context
            let body_snippet = resp.text().await.unwrap_or_default();
            let is_cloudflare = server.to_lowercase().contains("cloudflare") || cf_ray.is_some();
            let has_js_challenge = body_snippet.contains("challenge-platform")
                || body_snippet.contains("jschl-answer")
                || body_snippet.contains("Checking your browser")
                || body_snippet.contains("Just a moment");
            let has_captcha = body_snippet.contains("cf-turnstile")
                || body_snippet.contains("hcaptcha")
                || body_snippet.contains("recaptcha");

            let mut detail = match code {
                401 => "Unauthorized - server requires authentication or cookies".to_string(),
                403 if is_cloudflare && has_js_challenge =>
                    "Cloudflare JS challenge - this site requires browser verification. Use the browser extension to capture this download.".to_string(),
                403 if is_cloudflare && has_captcha =>
                    "Cloudflare CAPTCHA - this site requires human verification. Open the URL in your browser, complete the challenge, then use the browser extension.".to_string(),
                403 if is_cloudflare =>
                    "Cloudflare blocked - the server's firewall rejected this request. Try opening the URL in your browser first, then use the browser extension.".to_string(),
                403 => "Forbidden - access denied by server".to_string(),
                404 => "Not Found - file does not exist at this URL".to_string(),
                410 => "Gone - file has been removed".to_string(),
                429 => "Too Many Requests - rate limited, try again later or use a VPN to change your IP".to_string(),
                500..=599 => "Server error - try again later".to_string(),
                _ => "Unexpected error".to_string(),
            };

            // Append server info for diagnostics
            let mut diag = vec![format!("server: {}", server)];
            if let Some(ray) = cf_ray { diag.push(format!("cf-ray: {}", ray)); }
            if let Some(cache) = cf_cache { diag.push(format!("cf-cache: {}", cache)); }
            if content_type != "unknown" { diag.push(format!("content-type: {}", content_type)); }
            detail.push_str(&format!(" [{}]", diag.join(", ")));

            return Err(format!("HTTP {} - {}", code, detail));
        }

        let total = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(download.total_bytes);

        // Update total bytes if we got it from GET
        if total > 0 {
            let mut downloads = self.downloads.lock().await;
            if let Some(d) = downloads.iter_mut().find(|d| d.id == id) {
                d.total_bytes = total;
            }
        }

        // Ensure parent directory exists
        if let Some(parent) = PathBuf::from(&download.save_path).parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&download.save_path)
            .await
            .map_err(|e| format!("Failed to create file: {}", e))?;

        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_tick = std::time::Instant::now();
        let mut bytes_since_tick: u64 = 0;
        let cancel_flags = self.cancel_flags.clone();
        let pause_flags = self.pause_flags.clone();
        let downloads = self.downloads.clone();

        while let Some(chunk) = stream.next().await {
            // Check cancel - read flag then drop lock immediately
            let is_cancelled = {
                let flags = cancel_flags.lock().await;
                flags.get(&id).copied().unwrap_or(false)
            };
            if is_cancelled {
                let mut dls = downloads.lock().await;
                if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
                    d.status = DownloadStatus::Cancelled;
                    on_progress(d);
                }
                drop(dls);
                let _ = fs::remove_file(&download.save_path).await;
                return Ok(());
            }

            // Check pause - read flag then drop lock immediately
            let is_paused = {
                let flags = pause_flags.lock().await;
                flags.get(&id).copied().unwrap_or(false)
            };
            if is_paused {
                {
                    let mut dls = downloads.lock().await;
                    if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
                        d.status = DownloadStatus::Paused;
                        on_progress(d);
                    }
                }
                // Wait until unpaused or cancelled - no locks held across sleep
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let still_paused = {
                        let pf = pause_flags.lock().await;
                        pf.get(&id).copied().unwrap_or(false)
                    };
                    let is_cancelled = {
                        let cf = cancel_flags.lock().await;
                        cf.get(&id).copied().unwrap_or(false)
                    };
                    if !still_paused || is_cancelled {
                        break;
                    }
                }
                {
                    let mut dls = downloads.lock().await;
                    if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
                        d.status = DownloadStatus::Downloading;
                        on_progress(d);
                    }
                }
                continue;
            }

            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    let detail = if e.is_timeout() {
                        "connection timed out - server stopped responding"
                    } else if e.is_connect() {
                        "connection lost - network may be down"
                    } else if e.is_body() {
                        "server sent corrupted/truncated data (body decode error)"
                    } else if e.is_decode() {
                        "response decode error - content encoding mismatch"
                    } else {
                        "unknown stream error"
                    };
                    let pct = if download.total_bytes > 0 {
                        format!(" at {:.1}% ({}/{})",
                            (downloaded as f64 / download.total_bytes as f64) * 100.0,
                            crate::download::human_bytes(downloaded),
                            crate::download::human_bytes(download.total_bytes))
                    } else {
                        format!(" after {}", crate::download::human_bytes(downloaded))
                    };
                    return Err(format!("Stream failed{}: {} - {}", pct, detail, e));
                }
            };
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Write error: {}", e))?;

            downloaded += chunk.len() as u64;
            bytes_since_tick += chunk.len() as u64;

            // Emit progress every 100ms
            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_tick);
            if elapsed.as_millis() >= 100 {
                let speed = (bytes_since_tick as f64 / elapsed.as_secs_f64()) as u64;
                let mut dls = downloads.lock().await;
                if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
                    d.downloaded_bytes = downloaded;
                    d.speed_bps = speed;
                    on_progress(d);
                }
                bytes_since_tick = 0;
                last_tick = now;
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Flush error: {}", e))?;

        // Mark completed
        {
            let mut dls = downloads.lock().await;
            if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
                d.downloaded_bytes = downloaded;
                d.speed_bps = 0;
                d.status = DownloadStatus::Completed;
                on_progress(d);
            }
        }

        Ok(())
    }

    pub async fn pause_download(&self, id: &str) {
        let mut flags = self.pause_flags.lock().await;
        flags.insert(id.to_string(), true);
    }

    pub async fn resume_download(&self, id: &str) {
        let mut flags = self.pause_flags.lock().await;
        flags.insert(id.to_string(), false);
    }

    pub async fn cancel_download(&self, id: &str) {
        let mut flags = self.cancel_flags.lock().await;
        flags.insert(id.to_string(), true);
    }

    pub async fn reset_for_retry(&self, id: &str) -> Result<(), String> {
        let mut downloads = self.downloads.lock().await;
        let d = downloads.iter_mut().find(|d| d.id == id)
            .ok_or("Download not found")?;
        if d.status != DownloadStatus::Failed && d.status != DownloadStatus::Cancelled {
            return Err("Can only retry failed or cancelled downloads".to_string());
        }
        d.status = DownloadStatus::Queued;
        d.downloaded_bytes = 0;
        d.speed_bps = 0;
        d.error = None;
        drop(downloads);
        // Reset flags
        {
            let mut cf = self.cancel_flags.lock().await;
            cf.insert(id.to_string(), false);
        }
        {
            let mut pf = self.pause_flags.lock().await;
            pf.insert(id.to_string(), false);
        }
        Ok(())
    }

    pub async fn remove_download(&self, id: &str) {
        let mut downloads = self.downloads.lock().await;
        downloads.retain(|d| d.id != id);
        let mut cf = self.cancel_flags.lock().await;
        cf.remove(id);
        let mut pf = self.pause_flags.lock().await;
        pf.remove(id);
    }

    async fn update_status(&self, id: &str, status: DownloadStatus) {
        let mut downloads = self.downloads.lock().await;
        if let Some(d) = downloads.iter_mut().find(|d| d.id == id) {
            d.status = status;
        }
    }

    pub async fn get_all_downloads(&self) -> Vec<Download> {
        let downloads = self.downloads.lock().await;
        downloads.clone()
    }
}
