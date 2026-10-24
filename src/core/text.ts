/**
 * Rich-text work item fields are HTML. This is a tag stripper for
 * terminal display — it covers the markup and entities that actually
 * show up, not HTML in general.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cuts text at `max` characters, saying whether it did so callers can offer `--full`. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}…`, truncated: true };
}

/** The last `max` lines. */
export function tail(text: string, max: number): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split('\n');
  if (lines.length <= max) return { text, truncated: false, totalLines: lines.length };
  return { text: lines.slice(-max).join('\n'), truncated: true, totalLines: lines.length };
}
