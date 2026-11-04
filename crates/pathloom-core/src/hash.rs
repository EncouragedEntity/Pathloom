use sha2::{Digest, Sha256};
use std::fmt::Write;

/// sha256 of `bytes` as lowercase hex.
pub fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}
