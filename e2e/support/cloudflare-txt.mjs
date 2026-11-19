// What Cloudflare stores and returns as the `content` of a TXT record, for the two stand-ins (test/helpers/cf-fake.ts and e2e/support/fake-cloudflare.mjs).
// Basis, from Cloudflare's documentation: the content "must consist of quoted "character strings" (RFC 1035), each with a length of up to 255 bytes.
// Strings exceeding this allowed maximum length are automatically split" (API, Create DNS Record:
// https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/), and "if you save your TXT content without any quotes,
// Cloudflare will automatically add double quotes" (https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/).
// So: unquoted content is stored as one quoted string; any string over 255 bytes is cut into 255-byte strings; the result is `"a" "b"`.
// It models Cloudflare, not our encoder (packages/dns-checks/src/txt.ts): it cuts blindly by bytes, as a stand-in for a service we do not control.

/** @param {string} content @returns {string} */
export function cloudflareTxtContent(content) {
  const raw = String(content).trim();
  const strings = raw.startsWith('"') ? [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]) : [raw.replace(/["\\]/g, '\\$&')];
  const out = [];
  for (const str of strings) {
    const bytes = new TextEncoder().encode(str);
    if (bytes.length <= 255) { out.push(str); continue; }
    for (let i = 0; i < bytes.length; i += 255) out.push(new TextDecoder().decode(bytes.subarray(i, i + 255)));
  }
  return out.map(x => `"${x}"`).join(' ');
}
