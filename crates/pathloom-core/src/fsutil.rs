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

/// Current UTC time as `YYYY-MM-DDTHH:MMZ` (the comment timestamp format).
pub(crate) fn now_minute() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
    format_minute(secs)
}

/// Unix seconds to `YYYY-MM-DDTHH:MMZ` (civil-from-days, H. Hinnant).
pub(crate) fn format_minute(secs: i64) -> String {
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
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}Z", rem / 3600, rem % 3600 / 60)
}

/// Public atomic write (temp file, fsync, rename) that also records the write in [`crate::writes`].
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic(path, bytes).map_err(|e| match e {
        crate::error::Error::Io(io) => io,
        other => std::io::Error::other(other.to_string()),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn minute_format() {
        assert_eq!(super::format_minute(0), "1970-01-01T00:00Z");
        assert_eq!(super::format_minute(1_793_788_920), "2026-11-04T10:42Z");
    }
}
