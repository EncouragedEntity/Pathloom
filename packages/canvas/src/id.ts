const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32 (lowercase)

/** 'e' + 10 random base32 chars, e.g. `e7k3q9xmbd`. */
export function newId(len = 10): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return 'e' + s;
}

export const newSeed = () => Math.floor(Math.random() * 2 ** 31);
