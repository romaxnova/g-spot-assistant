/**
 * gmail_find_contacts: finds an email address from a name ("Moreau" ->
 * contact@maisonmoreau.fr) among the people the account has exchanged mail
 * with. Gmail only: the From/To/Cc/Bcc headers of the most recent messages
 * that mention the name are read, every address in them is gathered, and the
 * ones whose address or names match are ranked, so no Google Contacts access
 * is needed. Drafts, chats and no-reply senders are not correspondence and
 * are left out. Nothing here logs names or addresses.
 */
import * as z from 'zod';
import { accountParam, defineTool, jsonResult, type ToolContext, type ToolDefinition } from '../registry.js';
import { GoogleApiError } from '../../google/client.js';
import { formatInZone } from './calendar-dates.js';
import { gmailIdentity, mailbox } from './gmail-identity.js';
import { headerValue, parseAddresses } from './gmail-mime.js';
import { FETCH_CONCURRENCY, getMessage, guarded, InputError, mapLimit, SERVICE, type GmailMessage } from './gmail.js';

const ADDRESS_HEADERS = ['From', 'To', 'Cc', 'Bcc'] as const;
/** Characters with a meaning in Gmail's search syntax inside from:(...); dropped from the query. */
const SEARCH_SYNTAX = /["(){}:\\]/g;
const LOOKS_LIKE_ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;
/** Punctuation around a word ("Moreau," "<sm@moreau.fr>", a negating "-"): Gmail ignores or misreads it. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{M}\p{N}@]+|[^\p{L}\p{M}\p{N}@]+$/gu;
/** Gmail search operators, which would otherwise be words the contact must match. */
const OPERATORS = new Set(['OR', 'AND']);
/** Messages that are not mail exchanged with someone: unsent drafts, chats. */
const SKIPPED_LABELS = new Set(['DRAFT', 'CHAT']);
/**
 * Local parts of addresses that send automatically and read no replies (drive-shares-dm-noreply, calendar-notification,
 * bounces+x), in English, French (ne-pas-repondre, noreponse), Spanish, Portuguese, German and Italian.
 */
export const AUTOMATED_SENDER =
  /(^|[-_.])(no[-_.]?reply|do[-_.]?not[-_.]?reply|ne[-_.]?pas[-_.]?repondre|ne[-_.]?repondez[-_.]?pas|no[-_.]?reponse|no[-_.]?responder|no[-_.]?responda|nao[-_.]?responda|nicht[-_.]?antworten|keine[-_.]?antwort|non[-_.]?rispondere|notifications?|mailer-daemon|bounces?)([-_.+]|$)/i;
/** Names a relay gives someone else's mail ("Ann via Book-Club", "Ann (via Google Drive)"): the person's, not the address's. */
const RELAYED_NAME = /\S\s+\(?via\s+\S|\((via\s+)?Google (Drive|Docs|Sheets|Slides|Forms|Calendar)\)/i;
/** A display name that reads well unquoted: letters of any script, digits, atext symbols and spaces. */
const PLAIN_NAME = /^[\p{L}\p{M}\p{N}!#$%&'*+\-/=?^_`{|}~ ]+$/u;

interface MessageList {
  messages?: { id: string; threadId: string }[];
}

interface Contact {
  email: string;
  /** Display name -> how many messages used it, and the latest of them. */
  names: Map<string, { count: number; lastMs: number }>;
  messages: number;
  lastMs: number;
  youWrote: number;
  theyWrote: number;
}

/** Accent- and case-insensitive form: "Stéphane" and "STEPHANE" both become "stephane". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The query's words without Gmail search syntax: special characters, punctuation around words and OR/AND dropped. */
export function cleanContactQuery(query: string): string {
  return query
    .replace(SEARCH_SYNTAX, ' ')
    .split(/\s+/)
    .map((w) => w.replace(EDGE_PUNCTUATION, ''))
    .filter((w) => w && !OPERATORS.has(w))
    .join(' ');
}

/** A display name worth showing: quotes and doubled spaces dropped; none when it only repeats the address. */
function displayName(name: string | undefined, email: string): string | undefined {
  const n = name?.replace(/\s+/g, ' ').trim().replace(/^'(.*)'$/, '$1').trim();
  return n && n.toLowerCase() !== email ? n : undefined;
}

/**
 * "Name <addr>" as people read and type it, quoted when the name has specials.
 * Never RFC 2047-encoded (formatAddress's header form): gmail_send and
 * gmail_create_draft encode the name when the mail is built.
 */
function readableAddress(name: string | undefined, email: string): string {
  if (!name) return email;
  return PLAIN_NAME.test(name) ? `${name} <${email}>` : `"${name.replace(/["\\]/g, '\\$&')}" <${email}>`;
}

function messageMs(m: GmailMessage): number {
  const ms = Number(m.internalDate);
  if (m.internalDate && Number.isFinite(ms)) return ms;
  const header = Date.parse(headerValue(m.payload?.headers, 'Date') ?? '');
  return Number.isFinite(header) ? header : 0;
}

/** Metadata of one message; undefined when it was deleted since the list call. */
async function fetchHeaders(ctx: ToolContext, account: string, id: string): Promise<GmailMessage | undefined> {
  try {
    return await getMessage(ctx, account, id, 'metadata', [...ADDRESS_HEADERS, 'Date']);
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return undefined;
    throw err;
  }
}

function bestName(names: Contact['names']): string | undefined {
  let best: { name: string; count: number; lastMs: number } | undefined;
  for (const [name, seen] of names) {
    if (!best || seen.count > best.count || (seen.count === best.count && seen.lastMs > best.lastMs)) best = { name, ...seen };
  }
  return best?.name;
}

export const gmailFindContacts: ToolDefinition = defineTool({
  name: 'gmail_find_contacts',
  title: 'Find email addresses in Gmail',
  description:
    'Finds email addresses by a person\'s or company\'s name, or part of an address, among the people this account has exchanged mail with ' +
    '(From/To/Cc/Bcc of sent and received mail), e.g. "Moreau" -> contact@maisonmoreau.fr. Uses Gmail only (no Google Contacts access needed). ' +
    'Every word of the query must match the name or address; accents and case are ignored. ' +
    'The account\'s own addresses, drafts and no-reply/notification senders are left out. ' +
    'Returns contacts ranked by how many messages mention them: name, email, address (ready for to/cc), messages, last_seen, ' +
    'you_wrote (messages you sent that list them) and they_wrote (messages from them). Read-only.',
  service: SERVICE,
  inputSchema: {
    account: accountParam,
    query: z.string().min(2).max(100).describe('Name, company or part of the address, e.g. "Moreau", "Stéphane Martin", "maisonmoreau.fr".'),
    max_results: z.number().int().min(1).max(25).optional().describe('Contacts to return, 1-25 (default 10).'),
    scan: z
      .number()
      .int()
      .min(10)
      .max(200)
      .optional()
      .describe('How many of the most recent messages that mention the query to look at, 10-200 (default 60). Raise it for someone last written to long ago.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: guarded(async (args, ctx) => {
    const query = cleanContactQuery(args.query);
    if (query.length < 2) throw new InputError('query: give at least two letters of a name, company or address.');
    const tokens = fold(query).split(' ');
    const scan = args.scan ?? 60;
    const identity = await gmailIdentity(ctx, args.account);
    // Mailbox form, so the account's +tag, dotted and googlemail.com addresses are the account too.
    const own = new Set(identity.sendAs.map(mailbox));

    // Curly braces are OR in Gmail search: the name in any address field.
    const list = await ctx.google.request<MessageList>(args.account, SERVICE, {
      url: '/messages',
      query: { q: `{from:(${query}) to:(${query}) cc:(${query}) bcc:(${query})} -in:drafts`, maxResults: scan },
    });
    const ids = [...new Set((list.messages ?? []).map((m) => m.id))];
    const messages = (await mapLimit(ids, FETCH_CONCURRENCY, (id) => fetchHeaders(ctx, args.account, id))).filter(
      (m): m is GmailMessage => !!m && !m.labelIds?.some((l) => SKIPPED_LABELS.has(l)),
    );

    // Every address of the scanned messages first, then the query: an address
    // counts in each message it appears in, even where it has no name.
    const contacts = new Map<string, Contact>();
    for (const m of messages) {
      const h = m.payload?.headers;
      const ms = messageMs(m);
      const from = parseAddresses(headerValue(h, 'From'))[0]?.email.trim().toLowerCase();
      const fromMe = !!from && own.has(mailbox(from));
      // Each address once per message, with the names this message gives it.
      const seen = new Map<string, Set<string>>();
      for (const field of ADDRESS_HEADERS) {
        for (const a of parseAddresses(headerValue(h, field))) {
          const email = a.email.trim().toLowerCase();
          if (!LOOKS_LIKE_ADDRESS.test(email) || own.has(mailbox(email)) || AUTOMATED_SENDER.test(email.split('@')[0]!)) continue;
          const name = displayName(a.name, email);
          const names = seen.get(email) ?? new Set<string>();
          if (name && !RELAYED_NAME.test(name)) names.add(name);
          seen.set(email, names);
        }
      }
      for (const [email, names] of seen) {
        const c = contacts.get(email) ?? { email, names: new Map(), messages: 0, lastMs: 0, youWrote: 0, theyWrote: 0 };
        c.messages++;
        c.lastMs = Math.max(c.lastMs, ms);
        if (fromMe) c.youWrote++;
        if (from === email) c.theyWrote++;
        for (const name of names) {
          const n = c.names.get(name) ?? { count: 0, lastMs: 0 };
          c.names.set(name, { count: n.count + 1, lastMs: Math.max(n.lastMs, ms) });
        }
        contacts.set(email, c);
      }
    }

    const ranked = [...contacts.values()]
      .filter((c) => {
        const haystack = fold([c.email, ...c.names.keys()].join(' '));
        return tokens.every((t) => haystack.includes(t));
      })
      .sort((a, b) => b.messages - a.messages || b.lastMs - a.lastMs || a.email.localeCompare(b.email));
    ctx.log.debug('gmail find contacts', { alias: args.account, scanned: messages.length, contacts: ranked.length });
    if (!ranked.length) {
      // A larger scan only helps when this one stopped at its limit.
      const larger = ids.length >= scan && scan < 200 ? ', or a larger scan' : '';
      return jsonResult({
        scanned: messages.length,
        note: messages.length
          ? `No one matching "${query}" in the ${messages.length} most recent messages that mention it; try another spelling, part of the address${larger}.`
          : `No message mentions "${query}" in its From, To, Cc or Bcc; try another spelling or part of the address.`,
      });
    }
    return jsonResult({
      contacts: ranked.slice(0, args.max_results ?? 10).map((c) => {
        const name = bestName(c.names);
        return {
          name,
          email: c.email,
          address: readableAddress(name, c.email),
          messages: c.messages,
          last_seen: c.lastMs ? formatInZone(c.lastMs, ctx.config.defaultTimezone).slice(0, 10) : undefined,
          you_wrote: c.youWrote || undefined,
          they_wrote: c.theyWrote || undefined,
        };
      }),
      scanned: messages.length,
    });
  }),
});
