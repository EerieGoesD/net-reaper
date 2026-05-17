use futures_util::StreamExt;
use wreq::Client;
use wreq_util::Emulation;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, atomic::{AtomicU64, AtomicBool, Ordering}};
use tokio::fs;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
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
    Starting,
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
    /// ISO 8601 timestamp; if Some and in the future, kept Queued until reached
    #[serde(default)]
    pub scheduled_at: Option<String>,
    /// Number of parallel segments used; 1 means single-stream
    #[serde(default)]
    pub segments_used: u8,
    /// True if this is an HLS/m3u8 video extraction job
    #[serde(default)]
    pub is_hls: bool,
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
            scheduled_at: None,
            segments_used: 1,
            is_hls: false,
        }
    }
}

#[derive(Clone)]
pub struct DownloadManager {
    pub downloads: Arc<Mutex<Vec<Download>>>,
    client: Client,
    cancel_flags: Arc<Mutex<std::collections::HashMap<String, bool>>>,
    pause_flags: Arc<Mutex<std::collections::HashMap<String, bool>>>,
    request_cookies: Arc<Mutex<std::collections::HashMap<String, String>>>,
    request_methods: Arc<Mutex<std::collections::HashMap<String, String>>>,
    request_referers: Arc<Mutex<std::collections::HashMap<String, String>>>,
    request_user_agents: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// Global speed limit in KB/s (0 = unlimited). Shared across all downloads.
    speed_limit_kbps: Arc<AtomicU64>,
    /// Number of parallel segments per download (1 = no segmentation). Default 8.
    segments: Arc<AtomicU64>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            downloads: Arc::new(Mutex::new(Vec::new())),
            // wreq with Chrome 137 emulation: BoringSSL-driven TLS ClientHello,
            // HTTP/2 SETTINGS / pseudo-header order, and default headers all
            // matching a real Chrome browser. This is what gets us past
            // Cloudflare's deeper bot detection (JA3 + HTTP/2 fingerprint).
            // Per-request Cookie / Referer / User-Agent overrides from the
            // extension still happen in the request builders below.
            client: Client::builder()
                .emulation(Emulation::Chrome137)
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
            request_user_agents: Arc::new(Mutex::new(std::collections::HashMap::new())),
            speed_limit_kbps: Arc::new(AtomicU64::new(0)),
            segments: Arc::new(AtomicU64::new(8)),
        }
    }

    pub fn set_speed_limit(&self, kbps: u64) {
        self.speed_limit_kbps.store(kbps, Ordering::Relaxed);
    }

    pub fn get_speed_limit(&self) -> u64 {
        self.speed_limit_kbps.load(Ordering::Relaxed)
    }

    pub fn set_segments(&self, count: u64) {
        let clamped = count.clamp(1, 16);
        self.segments.store(clamped, Ordering::Relaxed);
    }

    pub fn get_segments(&self) -> u64 {
        self.segments.load(Ordering::Relaxed)
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
            .get(wreq::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        let filename = resp
            .headers()
            .get(wreq::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.split("filename=")
                    .nth(1)
                    .map(|f| f.trim_matches('"').to_string())
            })
            .unwrap_or_else(|| {
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
    pub async fn add_download(
        &self,
        url: String,
        save_dir: String,
        custom_filename: Option<String>,
        cookies: Option<String>,
        method: Option<String>,
        referer: Option<String>,
        user_agent: Option<String>,
        scheduled_at: Option<String>,
        is_hls: bool,
    ) -> Result<String, String> {
        // Only do an unauthenticated HEAD if the caller did not give us a
        // filename. Probing always burns a network round-trip and on
        // Cloudflare-protected URLs can trip bot detection or burn a
        // one-use token before the authenticated GET runs.
        let custom = custom_filename.filter(|n| !n.trim().is_empty());
        let (filename, total_bytes) = match custom {
            Some(n) => (n, 0u64),
            None => self
                .resolve_filename(&url)
                .await
                .unwrap_or_else(|_| ("download".to_string(), 0)),
        };
        let save_path = PathBuf::from(&save_dir)
            .join(&filename)
            .to_string_lossy()
            .to_string();

        let mut download = Download::new(url, filename, save_path);
        download.total_bytes = total_bytes;
        download.scheduled_at = scheduled_at;
        download.is_hls = is_hls;
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
        if let Some(ua) = user_agent {
            if !ua.trim().is_empty() {
                let mut uamap = self.request_user_agents.lock().await;
                uamap.insert(id.clone(), ua);
            }
        }

        Ok(id)
    }

    /// Probe HEAD to determine if server supports byte-range requests, plus the total length.
    /// Returns (supports_ranges, total_bytes).
    async fn probe_ranges(&self, id: &str, url: &str) -> (bool, u64) {
        let mut req = self.client.head(url);
        {
            let cmap = self.request_cookies.lock().await;
            if let Some(c) = cmap.get(id) { req = req.header("Cookie", c.as_str()); }
        }
        {
            let rmap = self.request_referers.lock().await;
            if let Some(r) = rmap.get(id) { req = req.header("Referer", r.as_str()); }
        }
        {
            let uamap = self.request_user_agents.lock().await;
            if let Some(ua) = uamap.get(id) { req = req.header("User-Agent", ua.as_str()); }
        }
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                let server = resp.headers().get("server")
                    .and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
                let cf_ray = resp.headers().get("cf-ray")
                    .and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
                let supports = resp.headers()
                    .get(wreq::header::ACCEPT_RANGES)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_lowercase().contains("bytes"))
                    .unwrap_or(false);
                let total = resp.headers()
                    .get(wreq::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(0);
                if !status.is_success() {
                    let url_short: String = url.chars().take(120).collect();
                    eprintln!(
                        "[probe_ranges] HEAD {} {} - server={}, cf-ray={}, supports_ranges={}, len={}",
                        status.as_u16(), url_short, server, cf_ray, supports, total,
                    );
                }
                (supports, total)
            }
            Err(e) => {
                eprintln!("[probe_ranges] HEAD network error: {}", e);
                (false, 0)
            }
        }
    }

    /// Public entry point used by commands
    pub async fn start_download<F>(&self, id: String, on_progress: F) -> Result<(), String>
    where
        F: Fn(&Download) + Send + Sync + 'static + Clone,
    {
        let (url, total_hint, is_hls) = {
            let downloads = self.downloads.lock().await;
            let d = downloads.iter().find(|d| d.id == id).ok_or("Download not found")?;
            (d.url.clone(), d.total_bytes, d.is_hls)
        };

        // Flip to Starting and push one progress event so the UI shows
        // "Starting, Please Wait..." while the HEAD probe / initial connect
        // runs. The downstream paths flip to Downloading once bytes flow.
        self.update_status(&id, DownloadStatus::Starting).await;
        {
            let downloads = self.downloads.lock().await;
            if let Some(d) = downloads.iter().find(|d| d.id == id) {
                on_progress(d);
            }
        }

        if is_hls {
            return self.start_hls_download(id, on_progress).await;
        }

        let configured_segments = self.segments.load(Ordering::Relaxed) as u8;
        if configured_segments > 1 {
            let (supports, total) = self.probe_ranges(&id, &url).await;
            // Need a known content length AND server support, plus enough bytes to split usefully
            let usable_total = if total > 0 { total } else { total_hint };
            let min_per_segment: u64 = 1024 * 1024; // don't bother segmenting < 1MB pieces
            if supports && usable_total >= min_per_segment * configured_segments as u64 {
                return self.start_segmented_download(id, url, usable_total, configured_segments, on_progress).await;
            }
        }

        self.start_single_stream(id, on_progress).await
    }

    /// Original single-stream implementation (used as fallback when ranges unsupported)
    async fn start_single_stream<F>(&self, id: String, on_progress: F) -> Result<(), String>
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

        self.update_status(&id, DownloadStatus::Downloading).await;
        {
            let mut downloads = self.downloads.lock().await;
            if let Some(d) = downloads.iter_mut().find(|d| d.id == id) {
                d.segments_used = 1;
            }
        }

        let http_method = {
            let mmap = self.request_methods.lock().await;
            mmap.get(&id).cloned().unwrap_or_else(|| "GET".to_string())
        };

        // Resume support: if we have a partial file on disk smaller than the
        // expected total, attempt Range: bytes=N-. Server returns 206 if it
        // honors the range, 200 if it ignores it (then we restart fresh).
        let resume_from: u64 = match fs::metadata(&download.save_path).await {
            Ok(meta) => {
                let on_disk = meta.len();
                if download.total_bytes > 0
                    && on_disk > 0
                    && on_disk < download.total_bytes
                {
                    on_disk
                } else {
                    0
                }
            }
            Err(_) => 0,
        };

        let mut req = match http_method.as_str() {
            "POST" => self.client.post(&download.url),
            "PUT" => self.client.put(&download.url),
            _ => self.client.get(&download.url),
        };

        if resume_from > 0 {
            req = req.header("Range", format!("bytes={}-", resume_from));
            eprintln!(
                "[resume] {} attempting Range: bytes={}-/{} on {}",
                http_method, resume_from, download.total_bytes,
                download.url.chars().take(120).collect::<String>(),
            );
        }
        {
            let cmap = self.request_cookies.lock().await;
            if let Some(cookies) = cmap.get(&id) {
                req = req.header("Cookie", cookies.as_str());
            }
        }
        {
            let rmap = self.request_referers.lock().await;
            if let Some(referer) = rmap.get(&id) {
                req = req.header("Referer", referer.as_str());
            }
        }
        {
            let uamap = self.request_user_agents.lock().await;
            if let Some(ua) = uamap.get(&id) {
                req = req.header("User-Agent", ua.as_str());
            }
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("{} request failed: {}", http_method, e))?;

        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            let server = resp.headers().get("server")
                .and_then(|v| v.to_str().ok()).unwrap_or("unknown").to_string();
            let cf_ray = resp.headers().get("cf-ray")
                .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            let cf_cache = resp.headers().get("cf-cache-status")
                .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            let content_type = resp.headers().get("content-type")
                .and_then(|v| v.to_str().ok()).unwrap_or("unknown").to_string();
            let body_snippet = resp.text().await.unwrap_or_default();
            let is_cloudflare = server.to_lowercase().contains("cloudflare") || cf_ray.is_some();
            let has_js_challenge = body_snippet.contains("challenge-platform")
                || body_snippet.contains("jschl-answer")
                || body_snippet.contains("Checking your browser")
                || body_snippet.contains("Just a moment");
            let has_captcha = body_snippet.contains("cf-turnstile")
                || body_snippet.contains("hcaptcha")
                || body_snippet.contains("recaptcha");

            // Diagnostic: did the extension actually forward cookies/UA/referer for this id?
            let fwd_cookies = self.request_cookies.lock().await.get(&id).cloned();
            let fwd_ua = self.request_user_agents.lock().await.get(&id).cloned();
            let fwd_referer = self.request_referers.lock().await.get(&id).cloned();
            let cookie_count = fwd_cookies.as_ref()
                .map(|c| c.split(';').filter(|s| !s.trim().is_empty()).count())
                .unwrap_or(0);
            let has_cf_clearance = fwd_cookies.as_ref()
                .map(|c| c.contains("cf_clearance"))
                .unwrap_or(false);
            let has_browser_ua = fwd_ua.is_some();
            let has_referer = fwd_referer.is_some();
            let ext_forwarded = fwd_cookies.is_some() && has_browser_ua;

            // Mirror to stderr so the npm-run-dev terminal shows the full diagnostic.
            let url_short: String = download.url.chars().take(120).collect();
            eprintln!(
                "[download] {} {} {} - server={}, cf-ray={:?}, ct={}, cookies={} (cf_clearance={}), ua={}, referer={}, body_snippet={:?}",
                http_method, code, url_short,
                server, cf_ray, content_type,
                cookie_count, has_cf_clearance,
                if has_browser_ua { "browser" } else { "fallback" },
                has_referer,
                body_snippet.chars().take(200).collect::<String>(),
            );

            let mut detail = match code {
                401 => "Unauthorized - server requires authentication or cookies. Try clicking the download button again, or disable Brave Shields if using Brave browser".to_string(),
                403 if is_cloudflare && has_js_challenge && ext_forwarded =>
                    format!(
                        "Cloudflare bot challenge despite TLS impersonation (Chrome 137 emulation), \
                         forwarded cookies ({}, cf_clearance: {}), browser UA, and Referer. The site is \
                         using a stricter signal than JA3+cookies (likely turnstile, managed challenge, \
                         or an out-of-date emulation profile). Refresh the page in your browser to rotate \
                         cf_clearance and retry. If it still fails, the Chrome emulation profile may need \
                         updating in wreq-util.",
                        cookie_count,
                        if has_cf_clearance { "yes" } else { "NO - extension did not capture it" },
                    ),
                403 if is_cloudflare && has_js_challenge =>
                    "Cloudflare JS challenge - extension did not forward cookies/UA. Make sure Net Reaper Enable Downloads is on, then retry.".to_string(),
                403 if is_cloudflare && has_captcha =>
                    "Cloudflare CAPTCHA - this site requires human verification. Open the URL in your browser, complete the challenge, then retry.".to_string(),
                403 if is_cloudflare && ext_forwarded =>
                    format!(
                        "Cloudflare 403 despite forwarded cookies ({}, cf_clearance={}) and browser UA. Likely TLS fingerprint mismatch or token expired. Refresh in browser and retry.",
                        cookie_count, has_cf_clearance,
                    ),
                403 if is_cloudflare =>
                    "Cloudflare blocked - extension did not forward cookies/UA, so the server's firewall rejected this request.".to_string(),
                403 => "Forbidden - access denied by server".to_string(),
                404 => "Not Found - file does not exist at this URL".to_string(),
                410 => "Gone - file has been removed".to_string(),
                429 => "Too Many Requests - rate limited, try again later or use a VPN to change your IP".to_string(),
                500..=599 => "Server error - try again later".to_string(),
                _ => "Unexpected error".to_string(),
            };

            let mut diag = vec![format!("server: {}", server)];
            if let Some(ray) = cf_ray { diag.push(format!("cf-ray: {}", ray)); }
            if let Some(cache) = cf_cache { diag.push(format!("cf-cache: {}", cache)); }
            if content_type != "unknown" { diag.push(format!("content-type: {}", content_type)); }
            diag.push(format!("fwd: cookies={}/{}, ua={}, ref={}",
                cookie_count,
                if has_cf_clearance { "cfok" } else { "nocf" },
                if has_browser_ua { "yes" } else { "no" },
                if has_referer { "yes" } else { "no" },
            ));
            detail.push_str(&format!(" [{}]", diag.join(", ")));

            return Err(format!("HTTP {} - {}", code, detail));
        }

        // If we asked for a Range and got 206, the server honored resume.
        // If we asked for a Range and got 200, the server ignored it; we
        // must restart from byte 0 (truncate the partial).
        let actually_resumed = resume_from > 0 && status.as_u16() == 206;
        let effective_resume: u64 = if actually_resumed { resume_from } else { 0 };

        let response_len = resp
            .headers()
            .get(wreq::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        // For 206, Content-Length is the REMAINING bytes; full file is
        // effective_resume + response_len. For 200, Content-Length is the
        // full file.
        let total = if actually_resumed {
            effective_resume + response_len
        } else if response_len > 0 {
            response_len
        } else {
            download.total_bytes
        };

        if total > 0 {
            let mut downloads = self.downloads.lock().await;
            if let Some(d) = downloads.iter_mut().find(|d| d.id == id) {
                d.total_bytes = total;
                d.downloaded_bytes = effective_resume;
            }
        }

        if let Some(parent) = PathBuf::from(&download.save_path).parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        let mut file = if actually_resumed {
            let mut f = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(&download.save_path)
                .await
                .map_err(|e| format!("Failed to open file for resume: {}", e))?;
            f.seek(std::io::SeekFrom::Start(effective_resume))
                .await
                .map_err(|e| format!("Failed to seek to resume offset {}: {}", effective_resume, e))?;
            eprintln!(
                "[resume] honored - continuing from {} of {} (saved {} bytes of re-download)",
                effective_resume, total, effective_resume,
            );
            f
        } else {
            if resume_from > 0 {
                eprintln!(
                    "[resume] server returned {} instead of 206 - restarting from 0 (partial discarded)",
                    status.as_u16(),
                );
            }
            fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&download.save_path)
                .await
                .map_err(|e| format!("Failed to create file: {}", e))?
        };

        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = effective_resume;
        let mut last_tick = std::time::Instant::now();
        let mut bytes_since_tick: u64 = 0;
        let cancel_flags = self.cancel_flags.clone();
        let pause_flags = self.pause_flags.clone();
        let downloads = self.downloads.clone();

        while let Some(chunk) = stream.next().await {
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
                            human_bytes(downloaded),
                            human_bytes(download.total_bytes))
                    } else {
                        format!(" after {}", human_bytes(downloaded))
                    };
                    return Err(format!("Stream failed{}: {} - {}", pct, detail, e));
                }
            };
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Write error: {}", e))?;

            downloaded += chunk.len() as u64;
            bytes_since_tick += chunk.len() as u64;

            let limit_kbps = self.speed_limit_kbps.load(Ordering::Relaxed);
            if limit_kbps > 0 {
                let limit_bps = limit_kbps * 1024;
                let elapsed_since_tick = std::time::Instant::now().duration_since(last_tick).as_secs_f64();
                if elapsed_since_tick > 0.0 {
                    let current_rate = bytes_since_tick as f64 / elapsed_since_tick;
                    if current_rate > limit_bps as f64 {
                        let target_time = bytes_since_tick as f64 / limit_bps as f64;
                        let sleep_secs = target_time - elapsed_since_tick;
                        if sleep_secs > 0.001 {
                            tokio::time::sleep(std::time::Duration::from_secs_f64(sleep_secs)).await;
                        }
                    }
                }
            }

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

    /// Segmented download: split file into N byte ranges, fetch in parallel,
    /// each task writes to its own offset. Pre-allocates the file.
    async fn start_segmented_download<F>(
        &self,
        id: String,
        url: String,
        total: u64,
        segments: u8,
        on_progress: F,
    ) -> Result<(), String>
    where
        F: Fn(&Download) + Send + Sync + 'static + Clone,
    {
        let download = {
            let downloads = self.downloads.lock().await;
            downloads.iter().find(|d| d.id == id).cloned().ok_or("Download not found")?
        };

        self.update_status(&id, DownloadStatus::Downloading).await;
        {
            let mut downloads = self.downloads.lock().await;
            if let Some(d) = downloads.iter_mut().find(|d| d.id == id) {
                d.total_bytes = total;
                d.segments_used = segments;
            }
        }

        if let Some(parent) = PathBuf::from(&download.save_path).parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        // Pre-allocate the file with the exact size
        let prealloc = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&download.save_path)
            .await
            .map_err(|e| format!("Failed to create file: {}", e))?;
        prealloc.set_len(total).await.map_err(|e| format!("set_len failed: {}", e))?;
        drop(prealloc);

        // Per-segment progress counters
        let counters: Vec<Arc<AtomicU64>> = (0..segments).map(|_| Arc::new(AtomicU64::new(0))).collect();
        // Shared error sentinel - if one segment fails, others abort
        let aborted = Arc::new(AtomicBool::new(false));

        let chunk_size = total / segments as u64;
        let cookies_opt = {
            let cmap = self.request_cookies.lock().await;
            cmap.get(&id).cloned()
        };
        let referer_opt = {
            let rmap = self.request_referers.lock().await;
            rmap.get(&id).cloned()
        };
        let user_agent_opt = {
            let uamap = self.request_user_agents.lock().await;
            uamap.get(&id).cloned()
        };

        let mut handles = Vec::with_capacity(segments as usize);
        for i in 0..segments {
            let start_byte = i as u64 * chunk_size;
            let end_byte = if i == segments - 1 { total - 1 } else { start_byte + chunk_size - 1 };
            let counter = counters[i as usize].clone();
            let aborted_c = aborted.clone();
            let cancel_flags = self.cancel_flags.clone();
            let pause_flags = self.pause_flags.clone();
            let speed_limit = self.speed_limit_kbps.clone();
            let id_c = id.clone();
            let url_c = url.clone();
            let path_c = download.save_path.clone();
            let client = self.client.clone();
            let cookies_c = cookies_opt.clone();
            let referer_c = referer_opt.clone();
            let user_agent_c = user_agent_opt.clone();

            let handle = tokio::spawn(async move {
                let mut req = client.get(&url_c)
                    .header("Range", format!("bytes={}-{}", start_byte, end_byte));
                if let Some(c) = &cookies_c { req = req.header("Cookie", c.as_str()); }
                if let Some(r) = &referer_c { req = req.header("Referer", r.as_str()); }
                if let Some(ua) = &user_agent_c { req = req.header("User-Agent", ua.as_str()); }

                let resp = req.send().await
                    .map_err(|e| format!("segment {} request failed: {}", i, e))?;
                if !resp.status().is_success() && resp.status().as_u16() != 206 {
                    return Err(format!("segment {} HTTP {}", i, resp.status().as_u16()));
                }

                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .open(&path_c)
                    .await
                    .map_err(|e| format!("segment {} open failed: {}", i, e))?;
                file.seek(std::io::SeekFrom::Start(start_byte))
                    .await
                    .map_err(|e| format!("segment {} seek failed: {}", i, e))?;

                let mut stream = resp.bytes_stream();
                let mut last_throttle_tick = std::time::Instant::now();
                let mut bytes_since_throttle: u64 = 0;
                let segment_share = segments as u64; // divide global limit across segments

                while let Some(chunk) = stream.next().await {
                    if aborted_c.load(Ordering::Relaxed) {
                        return Err(format!("segment {} aborted", i));
                    }
                    // Pause/cancel checks
                    let is_cancelled = {
                        let flags = cancel_flags.lock().await;
                        flags.get(&id_c).copied().unwrap_or(false)
                    };
                    if is_cancelled {
                        return Err(format!("segment {} cancelled", i));
                    }
                    let is_paused = {
                        let flags = pause_flags.lock().await;
                        flags.get(&id_c).copied().unwrap_or(false)
                    };
                    if is_paused {
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            let still_paused = {
                                let pf = pause_flags.lock().await;
                                pf.get(&id_c).copied().unwrap_or(false)
                            };
                            let is_cancelled = {
                                let cf = cancel_flags.lock().await;
                                cf.get(&id_c).copied().unwrap_or(false)
                            };
                            if !still_paused || is_cancelled {
                                break;
                            }
                        }
                    }

                    let chunk = chunk.map_err(|e| format!("segment {} stream error: {}", i, e))?;
                    file.write_all(&chunk).await
                        .map_err(|e| format!("segment {} write error: {}", i, e))?;
                    counter.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    bytes_since_throttle += chunk.len() as u64;

                    // Per-segment throttle: divide global limit across segments
                    let limit_kbps = speed_limit.load(Ordering::Relaxed);
                    if limit_kbps > 0 {
                        let limit_bps = (limit_kbps * 1024) / segment_share.max(1);
                        let elapsed = std::time::Instant::now().duration_since(last_throttle_tick).as_secs_f64();
                        if elapsed > 0.0 {
                            let current_rate = bytes_since_throttle as f64 / elapsed;
                            if current_rate > limit_bps as f64 {
                                let target = bytes_since_throttle as f64 / limit_bps as f64;
                                let sleep_secs = target - elapsed;
                                if sleep_secs > 0.001 {
                                    tokio::time::sleep(std::time::Duration::from_secs_f64(sleep_secs)).await;
                                }
                            }
                        }
                        if elapsed > 1.0 {
                            bytes_since_throttle = 0;
                            last_throttle_tick = std::time::Instant::now();
                        }
                    }
                }

                file.flush().await.map_err(|e| format!("segment {} flush: {}", i, e))?;
                Ok::<(), String>(())
            });
            handles.push(handle);
        }

        // Progress aggregation task
        let counters_p = counters.clone();
        let downloads_p = self.downloads.clone();
        let id_p = id.clone();
        let aborted_p = aborted.clone();
        let cancel_flags_p = self.cancel_flags.clone();
        let pause_flags_p = self.pause_flags.clone();
        let on_progress_p = on_progress.clone();
        let progress_handle = tokio::spawn(async move {
            let mut last_total: u64 = 0;
            let mut last_tick = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                if aborted_p.load(Ordering::Relaxed) { break; }
                let total_now: u64 = counters_p.iter().map(|c| c.load(Ordering::Relaxed)).sum();
                let now = std::time::Instant::now();
                let elapsed = now.duration_since(last_tick).as_secs_f64();
                let speed = if elapsed > 0.0 { ((total_now.saturating_sub(last_total)) as f64 / elapsed) as u64 } else { 0 };
                last_total = total_now;
                last_tick = now;

                let is_paused = {
                    let pf = pause_flags_p.lock().await;
                    pf.get(&id_p).copied().unwrap_or(false)
                };
                let is_cancelled = {
                    let cf = cancel_flags_p.lock().await;
                    cf.get(&id_p).copied().unwrap_or(false)
                };

                let mut dls = downloads_p.lock().await;
                if let Some(d) = dls.iter_mut().find(|d| d.id == id_p) {
                    d.downloaded_bytes = total_now;
                    if is_cancelled {
                        d.status = DownloadStatus::Cancelled;
                        d.speed_bps = 0;
                        on_progress_p(d);
                        break;
                    } else if is_paused {
                        d.status = DownloadStatus::Paused;
                        d.speed_bps = 0;
                    } else {
                        d.status = DownloadStatus::Downloading;
                        d.speed_bps = speed;
                    }
                    on_progress_p(d);
                    if total_now >= total {
                        break;
                    }
                }
            }
        });

        // Wait for all segment tasks
        let mut first_err: Option<String> = None;
        for h in handles {
            match h.await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                        aborted.store(true, Ordering::Relaxed);
                    }
                }
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(format!("task join error: {}", e));
                        aborted.store(true, Ordering::Relaxed);
                    }
                }
            }
        }
        let _ = progress_handle.await;

        if let Some(err) = first_err {
            // Was it a user-initiated cancel?
            let was_cancelled = {
                let flags = self.cancel_flags.lock().await;
                flags.get(&id).copied().unwrap_or(false)
            };
            if was_cancelled {
                let mut dls = self.downloads.lock().await;
                if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
                    d.status = DownloadStatus::Cancelled;
                    on_progress(d);
                }
                drop(dls);
                let _ = fs::remove_file(&download.save_path).await;
                return Ok(());
            }
            // Real error: try to clean up the half-written file
            let _ = fs::remove_file(&download.save_path).await;
            return Err(err);
        }

        // Mark complete
        let total_dl: u64 = counters.iter().map(|c| c.load(Ordering::Relaxed)).sum();
        let mut dls = self.downloads.lock().await;
        if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
            d.downloaded_bytes = total_dl.max(total);
            d.speed_bps = 0;
            d.status = DownloadStatus::Completed;
            on_progress(d);
        }
        Ok(())
    }

    /// HLS/m3u8 download via system ffmpeg. Reads stderr for progress.
    async fn start_hls_download<F>(&self, id: String, on_progress: F) -> Result<(), String>
    where
        F: Fn(&Download) + Send + Sync + 'static + Clone,
    {
        let download = {
            let downloads = self.downloads.lock().await;
            downloads.iter().find(|d| d.id == id).cloned().ok_or("Download not found")?
        };

        self.update_status(&id, DownloadStatus::Downloading).await;
        {
            let mut downloads = self.downloads.lock().await;
            if let Some(d) = downloads.iter_mut().find(|d| d.id == id) {
                d.segments_used = 1;
            }
        }

        if let Some(parent) = PathBuf::from(&download.save_path).parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        // Locate ffmpeg
        let ffmpeg = which_ffmpeg()
            .ok_or_else(|| "ffmpeg not found on PATH. Install ffmpeg (https://ffmpeg.org/download.html) and restart Net Reaper to use the video grabber.".to_string())?;

        // Build ffmpeg args: -y overwrite, -i URL, -c copy (no re-encode), output
        let referer_opt = {
            let rmap = self.request_referers.lock().await;
            rmap.get(&id).cloned()
        };
        let cookies_opt = {
            let cmap = self.request_cookies.lock().await;
            cmap.get(&id).cloned()
        };
        let user_agent_opt = {
            let uamap = self.request_user_agents.lock().await;
            uamap.get(&id).cloned()
        };

        let mut cmd = tokio::process::Command::new(&ffmpeg);
        cmd.arg("-y");
        cmd.arg("-hide_banner");
        cmd.arg("-loglevel").arg("info");
        cmd.arg("-stats");
        if let Some(ua) = &user_agent_opt {
            cmd.arg("-user_agent").arg(ua);
        }
        if let Some(r) = &referer_opt {
            cmd.arg("-headers").arg(format!("Referer: {}\r\n", r));
        }
        if let Some(c) = &cookies_opt {
            cmd.arg("-headers").arg(format!("Cookie: {}\r\n", c));
        }
        cmd.arg("-i").arg(&download.url);
        cmd.arg("-c").arg("copy");
        cmd.arg("-bsf:a").arg("aac_adtstoasc");
        cmd.arg(&download.save_path);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().map_err(|e| format!("failed to spawn ffmpeg: {}", e))?;
        let stderr = child.stderr.take().ok_or("failed to capture ffmpeg stderr")?;
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(stderr).lines();

        let cancel_flags = self.cancel_flags.clone();
        let downloads = self.downloads.clone();
        let id_p = id.clone();
        let on_progress_monitor = on_progress.clone();

        let monitor = tokio::spawn(async move {
            let mut total_secs: f64 = 0.0;
            while let Ok(Some(line)) = reader.next_line().await {
                // Detect total duration
                if total_secs == 0.0 {
                    if let Some(idx) = line.find("Duration:") {
                        if let Some(t) = parse_ffmpeg_time(&line[idx + 9..]) {
                            total_secs = t;
                            let mut dls = downloads.lock().await;
                            if let Some(d) = dls.iter_mut().find(|d| d.id == id_p) {
                                d.total_bytes = (total_secs * 1000.0) as u64;
                                on_progress_monitor(d);
                            }
                        }
                    }
                }
                // Per-tick progress
                if let Some(idx) = line.find("time=") {
                    if let Some(t) = parse_ffmpeg_time(&line[idx + 5..]) {
                        let cancelled = {
                            let cf = cancel_flags.lock().await;
                            cf.get(&id_p).copied().unwrap_or(false)
                        };
                        let pseudo_done = (t * 1000.0) as u64;
                        let mut dls = downloads.lock().await;
                        if let Some(d) = dls.iter_mut().find(|d| d.id == id_p) {
                            d.downloaded_bytes = pseudo_done;
                            d.speed_bps = 0;
                            on_progress_monitor(d);
                        }
                        if cancelled { break; }
                    }
                }
            }
        });

        // Watch for cancellation
        let cancel_flags_w = self.cancel_flags.clone();
        let id_w = id.clone();
        let cancel_watch = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let cancelled = {
                    let cf = cancel_flags_w.lock().await;
                    cf.get(&id_w).copied().unwrap_or(false)
                };
                if cancelled { return true; }
            }
        });
        let cancel_abort = cancel_watch.abort_handle();

        let status = tokio::select! {
            res = child.wait() => {
                cancel_abort.abort();
                res.map_err(|e| format!("ffmpeg wait failed: {}", e))?
            }
            _ = cancel_watch => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = monitor.await;
                let _ = fs::remove_file(&download.save_path).await;
                let mut dls = self.downloads.lock().await;
                if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
                    d.status = DownloadStatus::Cancelled;
                    on_progress(d);
                }
                return Ok(());
            }
        };
        let _ = monitor.await;

        if !status.success() {
            let _ = fs::remove_file(&download.save_path).await;
            return Err(format!("ffmpeg exited with code {}", status.code().unwrap_or(-1)));
        }

        // Mark complete; use file size on disk as final
        let final_size = fs::metadata(&download.save_path).await.map(|m| m.len()).unwrap_or(0);
        let mut dls = self.downloads.lock().await;
        if let Some(d) = dls.iter_mut().find(|d| d.id == id) {
            d.downloaded_bytes = if final_size > 0 { final_size } else { d.total_bytes };
            d.total_bytes = if final_size > 0 { final_size } else { d.total_bytes };
            d.speed_bps = 0;
            d.status = DownloadStatus::Completed;
            on_progress(d);
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

/// Locate ffmpeg in PATH (Windows: ffmpeg.exe). Returns full path if found.
fn which_ffmpeg() -> Option<std::path::PathBuf> {
    let exe_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(sep) {
            let candidate = std::path::PathBuf::from(dir).join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Parse ffmpeg time strings like " 00:01:23.45" -> seconds
fn parse_ffmpeg_time(s: &str) -> Option<f64> {
    let s = s.trim_start();
    // grab the leading "HH:MM:SS.MS"
    let end = s.find(|c: char| c != ':' && c != '.' && !c.is_ascii_digit())
        .unwrap_or(s.len());
    let token = &s[..end];
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 { return None; }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}
