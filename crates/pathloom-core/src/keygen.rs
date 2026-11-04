//! Stage key generation from a title.

use crate::stagefile::is_valid_key;

fn translit(c: char) -> &'static str {
    match c.to_lowercase().next().unwrap_or(c) {
        'а' => "a", 'б' => "b", 'в' => "v", 'г' => "h", 'ґ' => "g", 'д' => "d",
        'е' | 'э' | 'ё' => "e", 'є' => "ie", 'ж' => "zh", 'з' => "z", 'и' | 'ы' => "y",
        'і' | 'ї' | 'й' => "i", 'к' => "k", 'л' => "l", 'м' => "m", 'н' => "n", 'о' => "o",
        'п' => "p", 'р' => "r", 'с' => "s", 'т' => "t", 'у' => "u", 'ф' => "f", 'х' => "kh",
        'ц' => "ts", 'ч' => "ch", 'ш' => "sh", 'щ' => "shch", 'ю' => "iu", 'я' => "ia",
        _ => "",
    }
}

/// Latin ASCII alphanumerics of a word (Cyrillic transliterated, other chars dropped), uppercase.
fn latin_word(w: &str) -> String {
    let mut s = String::new();
    for c in w.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_uppercase());
        } else {
            s.push_str(&translit(c).to_ascii_uppercase());
        }
    }
    s
}

/// Initials of the words (max 4); a single word gives its first 3 letters.
/// Result starts with a letter; empty title gives `S1`, `S2`, ... Collisions append 2, 3, ...
pub fn generate_key(title: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let words: Vec<String> = title
        .split(|c: char| !c.is_alphanumeric())
        .map(latin_word)
        .filter(|w| !w.is_empty())
        .collect();
    let mut base: String = if words.len() >= 2 {
        words.iter().filter_map(|w| w.chars().next()).take(4).collect()
    } else {
        words.first().map(|w| w.chars().take(3).collect()).unwrap_or_default()
    };
    base = base.trim_start_matches(|c: char| c.is_ascii_digit()).to_string();
    if base.is_empty() {
        return (1u32..10_000).map(|n| format!("S{n}")).find(|k| !taken(k)).unwrap_or_default();
    }
    if !taken(&base) {
        return base;
    }
    (2u32..10_000)
        .map(|n| format!("{base}{n}"))
        .find(|k| is_valid_key(k) && !taken(k))
        .unwrap_or(base)
}
