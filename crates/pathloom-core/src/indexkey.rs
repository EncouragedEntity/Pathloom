//! Fractional z-order keys: port of `packages/canvas/src/index-key.ts` (keep both in sync).

const D: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn pos(c: u8) -> Option<usize> {
    D.iter().position(|&d| d == c)
}

fn foreign(k: &str) -> bool {
    k.bytes().any(|c| pos(c).is_none())
}

fn midpoint(a: &str, b: Option<&str>) -> String {
    let (a, ab) = (a, a.as_bytes());
    if let Some(b) = b {
        let bb = b.as_bytes();
        let mut n = 0;
        while ab.get(n).copied().unwrap_or(b'0') == bb.get(n).copied().unwrap_or(0) && n < bb.len() {
            n += 1;
        }
        if n > 0 {
            return format!("{}{}", &b[..n], midpoint(&a[n.min(a.len())..], Some(&b[n..])));
        }
    }
    let da = ab.first().and_then(|&c| pos(c)).unwrap_or(0);
    let db = b.and_then(|b| b.as_bytes().first().and_then(|&c| pos(c))).unwrap_or(D.len());
    if db > da + 1 {
        return (D[(da + db).div_ceil(2)] as char).to_string();
    }
    if let Some(b) = b
        && b.len() > 1
    {
        return b[..1].to_string();
    }
    format!("{}{}", D[da] as char, midpoint(a.get(1..).unwrap_or(""), None))
}

/// A key strictly between `a` and `b` (`None` = open end).
pub(crate) fn key_between(a: Option<&str>, b: Option<&str>) -> String {
    let lo = a.unwrap_or("").trim_end_matches('0');
    let hi = b.map(|b| b.trim_end_matches('0'));
    if foreign(lo) || hi.is_some_and(|h| foreign(h) || lo >= h) {
        return format!("{}V", a.unwrap_or(""));
    }
    midpoint(lo, hi)
}

/// Next key after `last` (`a0`, `a1` .. `az`, `b00` ..).
pub(crate) fn key_after(last: Option<&str>) -> String {
    let Some(last) = last.filter(|l| !l.is_empty()) else { return "a0".into() };
    let bytes = last.as_bytes();
    let head = i32::from(bytes[0]) - 97;
    let digits = &bytes[1..];
    let n = (head + 1) as usize;
    if !(0..=25).contains(&head) || digits.len() != n || digits.iter().any(|&c| pos(c).is_none()) {
        return format!("{last}V");
    }
    let mut a = digits.to_vec();
    for i in (0..n).rev() {
        if a[i] == b'z' {
            a[i] = b'0';
        } else {
            a[i] = D[pos(a[i]).unwrap_or(0) + 1];
            return format!("{}{}", bytes[0] as char, String::from_utf8_lossy(&a));
        }
    }
    if head == 25 {
        return format!("{last}V");
    }
    format!("{}{}", (98 + head as u8) as char, "0".repeat(n + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn after_sequence() {
        assert_eq!(key_after(None), "a0");
        assert_eq!(key_after(Some("a0")), "a1");
        assert_eq!(key_after(Some("az")), "b00");
        assert_eq!(key_after(Some("weird!")), "weird!V");
    }

    #[test]
    fn between_is_ordered() {
        for (a, b) in [(None, Some("a0")), (Some("a0"), Some("a1")), (Some("a1"), None), (Some("a0"), Some("a0V"))] {
            let k = key_between(a, b);
            assert!(a.is_none_or(|a| a < k.as_str()), "{a:?} < {k}");
            assert!(b.is_none_or(|b| k.as_str() < b), "{k} < {b:?}");
        }
    }
}
