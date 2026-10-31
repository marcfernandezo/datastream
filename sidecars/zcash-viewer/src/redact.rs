//! Error-message redaction. Library and server errors can embed txids or
//! addresses; anything that leaves this process (logs, API) goes through here.

/// Masks every alphanumeric run of 26+ characters (txids, addresses, keys) to
/// `abcd…wxyz`, and caps the length.
pub fn redact(input: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(input.len().min(max_chars + 8));
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.chars().count() >= 26 {
            let chars: Vec<char> = token.chars().collect();
            out.extend(&chars[..4]);
            out.push('…');
            out.extend(&chars[chars.len() - 4..]);
        } else {
            out.push_str(token);
        }
        token.clear();
    };
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            token.push(c);
        } else {
            flush(&mut token, &mut out);
            out.push(c);
        }
    }
    flush(&mut token, &mut out);
    out.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_identifiers_and_keeps_prose() {
        let txid = "a".repeat(64);
        let msg = format!(
            "lightwalletd GetTransaction: tx {txid} failed at t1abcdefghijkmnopqrstuvwxyz12345678"
        );
        let r = redact(&msg, 300);
        assert!(!r.contains(&txid));
        assert!(r.contains("aaaa…aaaa"));
        assert!(r.contains("t1ab…5678"));
        assert!(r.starts_with("lightwalletd GetTransaction: tx "));
        assert_eq!(redact(&"x ".repeat(500), 10).chars().count(), 10);
    }
}
