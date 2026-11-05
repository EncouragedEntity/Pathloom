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
    let hash = crate::hash::hash_bytes(bytes);
    tmp.as_file().sync_all()?;
    let mut attempt = 0u32;
    loop {
        match tmp.persist(path) {
            Ok(_) => {
                crate::writes::record(path, &hash);
                return Ok(());
            }
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

/// Current UTC time as unix seconds (0 when the clock is before 1970).
pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

/// Current UTC time as RFC3339 `YYYY-MM-DDTHH:MM:SSZ` (log entries, claims).
pub fn now_rfc3339() -> String {
    format_secs(now_secs())
}

/// Current UTC time as `YYYY-MM-DDTHH:MMZ` (the comment timestamp format).
pub(crate) fn now_minute() -> String {
    format_minute(now_secs())
}

/// Unix seconds to `YYYY-MM-DDTHH:MMZ`.
pub(crate) fn format_minute(secs: i64) -> String {
    format!("{}Z", &format_secs(secs)[..16])
}

/// Unix seconds to RFC3339 UTC `YYYY-MM-DDTHH:MM:SSZ` (civil-from-days, H. Hinnant).
/// Fixed width, so the strings compare in time order.
pub(crate) fn format_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Public atomic write (temp file, fsync, rename) that also records the write in [`crate::writes`].
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic(path, bytes).map_err(|e| match e {
        crate::error::Error::Io(io) => io,
        other => std::io::Error::other(other.to_string()),
    })
}


/// Cross-process lock: a lock file created with `create_new`, removed on drop.
/// Waits up to ~2 s; a lock file older than 10 s is stale (its owner died) and is removed.
/// shortcut: two processes may both see a lock as stale and one removes the other's fresh lock;
/// only after a crash and within the same few ms, so not worth an OS-level lock yet.
pub(crate) struct FileLock(std::path::PathBuf);

impl FileLock {
    const STALE: Duration = Duration::from_secs(10);

    pub(crate) fn acquire(path: &Path) -> Result<FileLock> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(_) => return Ok(FileLock(path.to_path_buf())),
                // Windows reports a lock file being deleted as PermissionDenied.
                Err(e) if matches!(e.kind(), ErrorKind::AlreadyExists | ErrorKind::PermissionDenied) => {
                    let stale = std::fs::metadata(path)
                        .and_then(|m| m.modified())
                        .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > Self::STALE));
                    if stale {
                        let _ = std::fs::remove_file(path);
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(std::io::Error::new(ErrorKind::TimedOut, format!("lock {} is busy", path.display())).into());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn minute_format() {
        assert_eq!(super::format_minute(0), "1970-01-01T00:00Z");
        assert_eq!(super::format_minute(1_793_788_920), "2026-11-04T10:42Z");
        assert_eq!(super::format_secs(1_793_788_925), "2026-11-04T10:42:05Z");
    }
}
