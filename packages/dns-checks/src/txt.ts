// Dependency-free TXT helpers (the dashboard imports this directly).

/**
 * Decode TXT presentation data into the logical record string.
 * Handles `"a" "b"` (multiple character-strings, joined, with nothing between them: RFC 4408 §3.1.3 / RFC 6376
 * §3.6.2.2), `\"` and `\DDD` escapes inside quotes, and unquoted data (returned trimmed, as Google's DoH and the
 * Cloudflare API return it). Quotes are only read when the data starts with one, so a quote inside a record
 * (`n="note"`) is left alone.
 */
export function decodeTxtData(data: string): string {
  const s = data.trim();
  if (!s.startsWith('"')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const next = s[i + 1] ?? '';
          // \DDD decimal escape
          if (/\d/.test(next) && /^\d{3}$/.test(s.slice(i + 1, i + 4))) {
            out += String.fromCharCode(parseInt(s.slice(i + 1, i + 4), 10));
            i += 4;
            continue;
          }
          out += next;
          i += 2;
          continue;
        }
        out += s[i++];
      }
      i++; // closing quote
    } else {
      i++; // whitespace between character-strings
    }
  }
  return out;
}

/** RFC 1035 §3.3: one character-string holds at most 255 bytes. */
export const TXT_STRING_MAX_BYTES = 255;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The inverse of `decodeTxtData`: TXT content as quoted RFC 1035 character strings of at most 255 bytes, separated by a space, for the
 * Cloudflare API. Basis: "The content must consist of quoted “character strings” (RFC 1035), each with a length of up to 255 bytes.
 * Strings exceeding this allowed maximum length are automatically split." (Cloudflare API, Create DNS Record, TXT `content`:
 * https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/) and "if you save your TXT content without any
 * quotes, Cloudflare will automatically add double quotes" (https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/).
 * We quote and split ourselves so what we write is what Cloudflare stores, and what it reads back is the form `decodeTxtData` reads.
 *
 * Splits after a space (a term boundary in SPF and DMARC; the space stays at the end of the string, so the strings joined are the text) and,
 * only when a single word is longer than 255 bytes, inside the word, never inside a multi-byte character.
 */
export function encodeTxtData(text: string): string {
  const pieces: string[] = [];
  let current = '';
  let currentBytes = 0;
  const flush = () => { if (current) pieces.push(current); current = ''; currentBytes = 0; };
  // words with their trailing space, so the pieces joined are exactly `text`
  for (const word of text.match(/[^ ]* ?/g) ?? []) {
    if (!word) continue;
    let rest = word;
    let bytes = encoder.encode(rest).length;
    if (currentBytes + bytes <= TXT_STRING_MAX_BYTES) { current += rest; currentBytes += bytes; continue; }
    flush();
    // a word longer than one string: cut it by bytes, backing off to a character boundary
    while (bytes > TXT_STRING_MAX_BYTES) {
      const raw = encoder.encode(rest);
      let cut = TXT_STRING_MAX_BYTES;
      while (cut > 0 && (raw[cut]! & 0xc0) === 0x80) cut--;
      pieces.push(decoder.decode(raw.subarray(0, cut)));
      rest = decoder.decode(raw.subarray(cut));
      bytes = encoder.encode(rest).length;
    }
    current = rest;
    currentBytes = bytes;
  }
  flush();
  if (pieces.length === 0) pieces.push('');
  return pieces.map(p => `"${p.replace(/[\\"]/g, '\\$&')}"`).join(' ');
}
