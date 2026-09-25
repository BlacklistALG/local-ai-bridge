/**
 * Notion sometimes turns domain-like plain text (including a .md filename) into
 * a Markdown link on fetch. Ignore only that presentation change when the label
 * exactly equals the HTTP(S) URL's unencoded host/path. Never discard a different
 * destination, credentials, query, fragment, title, or escaped Markdown syntax.
 */
export function canonicalNotionText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(?<!\\)\[([^\[\]\\\r\n]+)\]\((https?:\/\/[^\s()]+)\)/g, (whole, label, destination) => {
    if (destination.replace(/^https?:\/\//, '') !== label) return whole;
    let url;
    try { url = new URL(destination); } catch { return whole; }
    if (url.username || url.password || url.search || url.hash || !url.hostname) return whole;
    return label;
  });
}

export function notionValueEquals(actual, expected) {
  return canonicalNotionText(actual) === canonicalNotionText(expected);
}
