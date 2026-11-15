// DNS text is written by whoever controls the domain, so it is treated as hostile when it is shown:
// - every control character (C0, DEL, C1) and every bidirectional or invisible formatting character (U+061C, U+200B–U+200F,
//   U+2028–U+202E, U+2060–U+2069, U+FEFF) is made visible as [U+XXXX] wherever DNS text is kept (records, names, messages), so a
//   right-to-left override cannot reorder what the reader sees and nothing invisible hides in a record;
// - DNS text quoted inside one of our own sentences loses those characters and is cut to QUOTE_MAX characters with an ellipsis,
//   so a record cannot write our sentences for us. The whole record appears only in the labelled record boxes.

/** Characters that change how the text around them is drawn, or are not drawn at all. */
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/** The longest DNS text quoted inside one of our sentences. */
export const QUOTE_MAX = 64;

const visible = (c: string) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`;

/** The text with every unsafe character replaced by a visible [U+XXXX]. */
export const inert = (text: string): string => text.replace(UNSAFE, visible);

/** DNS text to quote inside a sentence: unsafe characters dropped, at most QUOTE_MAX characters, an ellipsis when cut. */
export function quote(text: string): string {
  const chars = Array.from(text.replace(UNSAFE, ''));
  return chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX - 1).join('')}…` : chars.join('');
}

/** A message from the DNS checks with its quoted DNS value ("…") cut as quote() does, and nothing unsafe left anywhere in it. */
export const quoteValues = (message: string): string =>
  message.replace(/"(.*)"/s, (_m, inner: string) => `"${quote(inner)}"`).replace(UNSAFE, '');

/** A copy of a JSON value with inert() applied to every string in it. */
export function inertDeep<T>(value: T): T {
  if (typeof value === 'string') return inert(value) as T;
  if (Array.isArray(value)) return value.map((v) => inertDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, inertDeep(v)])) as T;
  }
  return value;
}
