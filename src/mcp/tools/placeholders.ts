/**
 * Unfilled blanks in outgoing mail. When a detail is missing, Claude writes a
 * blank such as "[téléphone]", "{{first_name}}" or "06 XX XX XX XX"; in a batch
 * of drafts one is easy to overlook, and a sent email cannot be taken back.
 * The send tools refuse text that still has them unless told they belong there;
 * the draft tools point them out as soon as they are written.
 */
import * as z from 'zod';

/** Words in square brackets, "[téléphone]" or "[Your name]"; not a Markdown link's text ("[text](url)"). */
const SQUARE = /\[([^[\]\n]{2,60})\](?!\()/g;
/** Square brackets that are not blanks: plain-text renderings of images and links, "[sic]", "[...]". */
const NOT_A_BLANK = /^\s*(?:image\s*:|cid:|https?:|mailto:|www\.|sic\s*$|\.{3}\s*$|…\s*$)/i;
const DOUBLE_BRACES = /\{\{[^{}\n]{1,60}\}\}/g;
const DOUBLE_ANGLES = /<<[^<>\n]{1,60}>>/g;
/** Numbers blanked with X: "06 XX XX XX XX", "XX.XX.XX.XX.XX", "XXXXX". */
const X_RUNS = /\b(?:\d{2}[ .-]?)?XX(?:[ .-]?XX){2,}\b|\bX{4,}\b/g;
/** A subject's leading tags ("Re:", "TR:", "[list-name]") are the sender's or a mailing list's, not blanks. */
const SUBJECT_TAGS = /^(?:\s*(?:re|fwd?|tr|aw|wg|sv|vs)\s*:|\s*\[[^\]\n]*\])*/i;
const MAX_LISTED = 10;

function blanksIn(text: string): { index: number; blank: string }[] {
  const found: { index: number; blank: string }[] = [];
  for (const m of text.matchAll(SQUARE)) {
    const inner = m[1]!;
    if (/\p{L}/u.test(inner) && !NOT_A_BLANK.test(inner) && !inner.includes('@') && !inner.includes('://')) found.push({ index: m.index, blank: m[0] });
  }
  for (const re of [DOUBLE_BRACES, DOUBLE_ANGLES, X_RUNS]) for (const m of text.matchAll(re)) found.push({ index: m.index, blank: m[0] });
  return found.sort((a, b) => a.index - b.index);
}

/** The blanks in a subject and text, each once, in the order they appear (subject first). */
export function findPlaceholders(parts: { subject?: string; texts?: (string | undefined)[] }): string[] {
  const subject = (parts.subject ?? '').replace(SUBJECT_TAGS, '');
  const all = [subject, ...(parts.texts ?? [])].flatMap((t) => (t ? blanksIn(t).map((b) => b.blank) : []));
  return [...new Set(all)].slice(0, MAX_LISTED);
}

export function quoteList(blanks: string[]): string {
  return blanks.map((b) => `"${b}"`).join(', ');
}

/** Why a send was refused, with the way out. */
export function placeholderRefusal(blanks: string[]): string {
  return (
    `Not sent: the message still has what look like unfilled blanks: ${quoteList(blanks)}. ` +
    'Ask the user for the missing details and fill them in; if they are meant to be in the message as written, call again with allow_placeholders: true.'
  );
}

/** For draft results: the blanks to fill before sending, or nothing. */
export function placeholderWarning(blanks: string[]): string | undefined {
  return blanks.length ? `The draft has what look like unfilled blanks: ${quoteList(blanks)}. Fill them in (ask the user) before sending; gmail_send_draft refuses them otherwise.` : undefined;
}

export const allowPlaceholdersParam = z
  .boolean()
  .optional()
  .describe('Send even though the text has what look like unfilled blanks ("[téléphone]", "{{name}}", "06 XX XX XX XX"). Only when the user confirmed they belong there; otherwise fill them in.');
