use crate::error::Result;
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::time::Duration;

/// Write `bytes` to `path` atomically (temp file in the same dir, fsync, rename).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    let mut attempt = 0u32;
    loop {
        match tmp.persist(path) {
            Ok(_) => return Ok(()),
            // Windows: target briefly locked by AV/indexer/reader.
            Err(e) if e.error.kind() == ErrorKind::PermissionDenied && attempt < 4 => {
                attempt += 1;
                tmp = e.file;
                std::thread::sleep(Duration::from_millis(20 * u64::from(attempt)));
            }
            Err(e) => return Err(e.error.into()),
        }
    }
}
