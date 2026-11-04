//! Process-global registry of files written by `pathloom-core` (for watcher echo suppression).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const MAX_ENTRIES: usize = 4096;

static REGISTRY: Mutex<Option<HashMap<PathBuf, String>>> = Mutex::new(None);

fn lock() -> MutexGuard<'static, Option<HashMap<PathBuf, String>>> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Remember that this process wrote `content_hash` to `path`. Called by every atomic write.
/// The registry is bounded: when full it is cleared (worst case: one echo is not suppressed).
pub fn record(path: &Path, content_hash: &str) {
    let mut g = lock();
    let map = g.get_or_insert_with(HashMap::new);
    if map.len() >= MAX_ENTRIES && !map.contains_key(path) {
        map.clear();
    }
    map.insert(path.to_path_buf(), content_hash.to_string());
}

/// True when the last write this process made to `path` has exactly this content hash.
pub fn is_own(path: &Path, content_hash: &str) -> bool {
    lock().as_ref().and_then(|m| m.get(path)).is_some_and(|h| h == content_hash)
}
