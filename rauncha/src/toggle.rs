//! Single-instance toggle for compositor rebinds: the same bind that spawns
//! the panel also closes it when pressed while open.
//!
//! Mechanism: a Unix socket in $XDG_RUNTIME_DIR. New spawn connects? Tell the
//! running panel to quit and exit ourselves. No instance? Bind the socket and
//! listen for future spawns.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

fn socket_path() -> PathBuf {
    let mut dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    dir.push("rauncha.sock");
    dir
}

pub fn request_or_announce() {
    let path = socket_path();

    // Already open? Close it and vanish.
    if let Ok(mut s) = UnixStream::connect(&path) {
        if s.write_all(b"quit").is_ok() {
            std::process::exit(0);
        }
    }

    // First spawn: own the socket and wait for the next press.
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else { return };
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut buf = [0u8; 16];
            let Ok(n) = (|| {
                let mut s = stream;
                s.read(&mut buf)
            })() else { continue };
            if buf[..n].starts_with(b"quit") {
                std::process::exit(0);
            }
        }
    });
}
