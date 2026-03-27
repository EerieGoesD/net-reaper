// Native Messaging Host for Net Reaper
//
// Chrome launches this process and communicates via stdin/stdout using
// the native messaging protocol: [4-byte LE length][JSON payload].
// This host forwards messages to the running Net Reaper app via a named pipe.

use std::io::{self, Read, Write};

#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\net-reaper";

#[cfg(not(windows))]
const PIPE_NAME: &str = "/tmp/net-reaper.sock";

fn read_message() -> io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    io::stdin().read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid message length"));
    }
    let mut msg = vec![0u8; len];
    io::stdin().read_exact(&mut msg)?;
    Ok(msg)
}

fn write_message(msg: &[u8]) -> io::Result<()> {
    let len = (msg.len() as u32).to_le_bytes();
    let mut out = io::stdout().lock();
    out.write_all(&len)?;
    out.write_all(msg)?;
    out.flush()
}

fn send_response(status: &str, message: Option<&str>) {
    let json = match message {
        Some(m) => format!(r#"{{"status":"{}","message":"{}"}}"#, status, m),
        None => format!(r#"{{"status":"{}"}}"#, status),
    };
    let _ = write_message(json.as_bytes());
}

fn forward_to_pipe(data: &[u8]) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::fs::OpenOptions;
        let mut pipe = OpenOptions::new().write(true).open(PIPE_NAME)?;
        pipe.write_all(data)?;
        pipe.write_all(b"\n")?;
        pipe.flush()?;
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::net::UnixStream;
        let mut stream = UnixStream::connect(PIPE_NAME)?;
        stream.write_all(data)?;
        stream.write_all(b"\n")?;
        stream.flush()?;
    }
    Ok(())
}

fn main() {
    loop {
        let msg = match read_message() {
            Ok(m) => m,
            Err(_) => break, // stdin closed, Chrome disconnected
        };

        match forward_to_pipe(&msg) {
            Ok(_) => send_response("ok", None),
            Err(_) => send_response("error", Some("Net Reaper is not running")),
        }
    }
}
