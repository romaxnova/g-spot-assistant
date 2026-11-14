/**
 * Sensitive contacts: people the user depends on, to whom a badly judged email
 * costs dearly. A bailiff who withdrew the same afternoon after a reproachful
 * mail (sent unattended at 08:00) is why this exists.
 *
 * Who counts: built-in categories recognised from the address (bailiffs,
 * lawyers, notaries, courts, administrations, insurers' claims services,
 * property managers), the owner's own list (sensitive_contacts), and anyone an
 * open follow-up waits on (they are handling a matter for the user). Linked
 * accounts and exempted entries never count.
 *
 * What it does: the send tools never send to them directly. gmail_send,
 * gmail_reply and gmail_forward save the mail as a draft instead; gmail_send_draft
 * sends it only with reviewed_by_user: true, which Claude may pass only after
 * the user saw that final text and the risks. The review handed to Claude is
 * built from facts the connector can establish without judging tone itself (it
 * has no AI and calls nothing but Google): the categories, how many emails
 * already went to them lately and whether they answered, the length of this
 * one, and wording that often reads as a reproach. The judgment stays Claude's;
 * the pause cannot be skipped. Logs carry counts and categories only.
 */
import { createHmac } from 'node:crypto';
import * as z from 'zod';
import { deriveKey } from '../../crypto.js';
import { accountParam, defineTool, jsonResult, ToolInputError, type ToolContext, type ToolDefinition } from '../registry.js';
import { cleanText } from '../text.js';
import { MAX_ENTRIES, SensitiveContactsError, type SensitiveList } from '../../contacts/sensitive-store.js';
import { mailbox } from './gmail-identity.js';
import { type Address } from './gmail-mime.js';

// Not imported from gmail.ts, which imports this module.
const SERVICE = 'gmail' as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SENSITIVE_CATEGORIES = ['bailiff', 'lawyer', 'notary', 'court', 'administration', 'insurer', 'property_manager'] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

const CATEGORY_LABELS: Record<SensitiveCategory | 'marked' | 'tracked', string> = {
  bailiff: 'a bailiff (commissaire de justice / huissier)',
  lawyer: 'a lawyer',
  notary: 'a notary',
  court: 'a court or its registry',
  administration: 'an administration',
  insurer: "an insurer or its claims expert",
  property_manager: 'a property manager (syndic)',
  marked: 'marked sensitive by the user',
  tracked: 'handling a matter for the user (an open follow-up waits on them)',
};

/** Built-in categories, matched on the whole address (local part and domain), lower-case. */
const PATTERNS: [SensitiveCategory, RegExp][] = [
  ['bailiff', /huissier|commissaires?[-_.]?(?:de[-_.]?)?justice|commissaire-justice|etude-huissier|@(?:[\w-]+\.)*(?:hdj|cdj)(?:[-.][\w-]+)*\.[a-z]+$|@(?:[\w-]+\.)*hdj[a-z]+\.[a-z]+$/],
  ['court', /@[^@]*(?:tribunal|greffe)|@(?:[\w-]+\.)*justice\.(?:gouv\.)?fr$|@[^@]*cour[-_.]?d[-_.]?appel|@[^@]*conseil[-_.]?de[-_.]?prud/],
  ['notary', /notaire|notariat|notaires\.fr$/],
  ['lawyer', /avocat|barreau|lawyer|law[-_.]?firm|@(?:[\w-]+\.)*legal[\w-]*\.|cabinet[-_.]?juridique/],
  [
    'administration',
    /\.gouv\.fr$|@(?:[\w-]+\.)*(?:caf|ameli|urssaf|francetravail|pole-emploi|impots|ants|cnav|msa|cpam|lassuranceretraite|service-public)\.fr$|@[^@]*(?:mairie|prefecture|dgfip)|@(?:[\w-]+\.)*ville-[\w-]+\.fr$/,
  ],
  [
    'insurer',
    /@[^@]*(?:assurance|insurance)|^sinistres?[-_.@]|@(?:[\w-]+\.)*(?:axa|swisslife|allianz|maif|macif|matmut|groupama|generali|mma|gmf|aviva|maaf|covea|eurexo|ixi-groupe|texa|polyexpert|saretec|elex)(?:-[\w-]+)?\.[a-z.]+$/,
  ],
  ['property_manager', /@[^@]*syndic(?!at)|@[^@]*copro(?:priete)?[-.]|@(?:[\w-]+\.)*(?:citya|foncia|nexity|oralia|sergic|loiselet|square-habitat|immodefrance|immo-de-france|lamy|rmv-gestion)(?:-[\w-]+)?\.[a-z.]+$/],
];

export function builtInCategory(address: string): SensitiveCategory | undefined {
  const a = address.trim().toLowerCase();
  return PATTERNS.find(([, re]) => re.test(a))?.[0];
}

export interface SensitiveContact {
  address: string;
  category: SensitiveCategory | 'marked' | 'tracked';
  why: string;
  note?: string;
}

function matches(entry: string, address: string): boolean {
  return entry.startsWith('@') ? address.endsWith(entry) || address.endsWith(`.${entry.slice(1)}`) : mailbox(entry) === mailbox(address);
}

/** The owner's list, or an empty one when the server has none (tests of other tools). */
function ownerList(ctx: ToolContext): SensitiveList {
  return ctx.sensitive?.get() ?? { marked: [], exempt: [] };
}

const UNREADABLE_WHY = "unchecked: the user's list of sensitive contacts cannot be read right now, so every outside recipient is reviewed";

/** Whether, and why, an address is a sensitive contact. */
export function classify(ctx: ToolContext, address: string, list = ownerList(ctx)): SensitiveContact | undefined {
  const a = address.trim().toLowerCase();
  if (!a.includes('@')) return undefined;
  const linked = ctx.accounts.list().some((acc) => mailbox(acc.email) === mailbox(a));
  if (linked || list.exempt.some((e) => matches(e, a))) return undefined;
  const marked = list.marked.find((m) => matches(m.entry, a));
  if (marked) return { address: a, category: 'marked', why: CATEGORY_LABELS.marked, note: marked.note };
  const category = builtInCategory(a);
  if (category) return { address: a, category, why: CATEGORY_LABELS[category] };
  const tracked = ctx.followups.list({ status: 'open' }).some((i) => (i.waiting_on ?? []).some((w) => mailbox(w) === mailbox(a)));
  if (tracked) return { address: a, category: 'tracked', why: CATEGORY_LABELS.tracked };
  return undefined;
}

/** The sensitive ones among a message's recipients, each once. */
export function sensitiveRecipients(ctx: ToolContext, recipients: Address[]): SensitiveContact[] {
  const list = ownerList(ctx);
  // A list that cannot be read fails closed: nobody the user marked may slip through.
  const unreadable = ctx.sensitive !== undefined && !ctx.sensitive.readable();
  const seen = new Set<string>();
  const out: SensitiveContact[] = [];
  for (const r of recipients) {
    const key = mailbox(r.email);
    if (seen.has(key)) continue;
    seen.add(key);
    const c = classify(ctx, r.email, list);
    if (c) out.push(c);
    else if (unreadable && !ctx.accounts.list().some((a) => mailbox(a.email) === key)) out.push({ address: r.email.trim().toLowerCase(), category: 'marked', why: UNREADABLE_WHY });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The review

/** Wording that often reads as a reproach, an ultimatum or irony to a professional (French and English). */
const TONE_MARKERS: RegExp[] = [
  /sans (?:plus de )?délai/i,
  /sans plus tarder/i,
  /je prends acte/i,
  /à (?:plusieurs|maintes) reprises/i,
  /une (?:nouvelle|énième) fois/i,
  /je vous rappelle/i,
  /comme (?:déjà|je vous l'ai|indiqué précédemment)/i,
  /inadmissible|inacceptable|scandaleu|lamentable/i,
  /mise en demeure|je vous mets en demeure/i,
  /à défaut|faute de quoi|je me verrai(?:s)? (?:contraint|dans l'obligation)/i,
  /dans les (?:plus )?brefs délais|au plus vite|immédiatement/i,
  /il est regrettable|je déplore|je m'étonne|je ne comprends pas/i,
  /négligence|manquement|votre responsabilité|faute professionnelle/i,
  /plainte|bâtonnier|chambre (?:régionale|nationale) des commissaires|conseil de l'ordre|ordre des avocats/i,
  /\b(?:ils|elles|cela|ce serait) (?:le )?seraient? bien moins\b/i,
  /without (?:further )?delay|once again|as i (?:already|previously) (?:said|wrote|told)|unacceptable|formal notice|otherwise i will|i will be forced|complaint/i,
];

/** Above this many words, a mail to a busy professional or an administration risks not being read. */
export const LONG_WORDS = 180;

export interface Cadence {
  address: string;
  /** Emails the account sent them in the last 7 and 14 days (any thread). */
  sent_last_7_days: number;
  sent_last_14_days: number;
  last_sent_at?: string;
  /** Their latest email to the account in the last 60 days. */
  last_heard_at?: string;
  /** Emails sent since their last one (or in 14 days, when they wrote none). */
  unanswered_in_a_row: number;
}

export interface SendReview {
  sensitive: SensitiveContact[];
  cadence: Cadence[];
  words: number;
  flags: string[];
  /** What Claude must do before this mail goes out. */
  ask: string;
  /** For drafts: what gmail_send_draft needs back (with reviewed_by_user) to send this exact version. */
  review_token?: string;
}

/**
 * Proof that a review was produced for this exact draft version: an edit gives the draft a new message id, so the
 * token no longer matches and the edited text is reviewed again.
 */
export function reviewToken(ctx: ToolContext, account: string, draftId: string, messageId: string): string {
  const key = deriveKey(ctx.config.encryptionKey, 'send review v1');
  return `rv_${createHmac('sha256', key).update(`${account.toLowerCase()}\n${draftId}\n${messageId}`).digest('base64url').slice(0, 22)}`;
}

export function wordCount(text: string): number {
  return (cleanText(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** Reproachful wording found in the text, each once, as written. */
export function toneMarkers(subject: string | undefined, text: string): string[] {
  const all = `${subject ?? ''}\n${text}`;
  const found = TONE_MARKERS.flatMap((re) => {
    const m = re.exec(all);
    return m ? [m[0]] : [];
  });
  if (/\bURGENT\b/.test(subject ?? '')) found.push('URGENT in the subject');
  if (/!{2,}|(?:![^!]*){3,}/.test(text)) found.push('several exclamation marks');
  return [...new Set(found)];
}

async function messageTimes(ctx: ToolContext, account: string, q: string, max: number): Promise<number[]> {
  const list = await ctx.google.request<{ messages?: { id: string }[] }>(account, SERVICE, { url: '/messages', query: { q, maxResults: max } });
  const read = await Promise.all(
    (list.messages ?? []).map((m) => ctx.google.request<{ internalDate?: string }>(account, SERVICE, { url: `/messages/${encodeURIComponent(m.id)}`, query: { format: 'minimal' } }).catch(() => undefined)),
  );
  return read.map((m) => Number(m?.internalDate)).filter((t) => Number.isFinite(t));
}

/** How often the account wrote to them lately, and whether they answered. Read-only, a few Gmail calls. */
/** Cadence lookups of one call, by account and address: a batch asks once per person. */
export type CadenceCache = Map<string, Promise<Cadence | undefined>>;

export async function cadenceWith(ctx: ToolContext, account: string, address: string, now = Date.now()): Promise<Cadence> {
  const a = address.trim().toLowerCase();
  const [sent, heard] = await Promise.all([
    messageTimes(ctx, account, `in:sent {to:${a} cc:${a} bcc:${a}} newer_than:14d`, 10),
    messageTimes(ctx, account, `from:${a} newer_than:60d -in:chats`, 1),
  ]);
  const lastHeard = heard.length ? Math.max(...heard) : undefined;
  const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());
  return {
    address: a,
    sent_last_7_days: sent.filter((t) => now - t <= 7 * DAY_MS).length,
    sent_last_14_days: sent.length,
    last_sent_at: iso(sent.length ? Math.max(...sent) : undefined),
    last_heard_at: iso(lastHeard),
    unanswered_in_a_row: sent.filter((t) => lastHeard === undefined || t > lastHeard).length,
  };
}

/**
 * The review of a mail to sensitive contacts: who they are, the recent cadence with each, this mail's length and
 * wording that reads as a reproach, and what Claude must show the user. Cadence lookups that fail are left out:
 * the review never blocks on them.
 */
export async function reviewFor(
  ctx: ToolContext,
  account: string,
  sensitive: SensitiveContact[],
  subject: string | undefined,
  text: string,
  cache: CadenceCache = new Map(),
): Promise<SendReview> {
  const lookup = (address: string) => {
    const key = `${account}\n${address}`;
    let p = cache.get(key);
    if (!p) cache.set(key, (p = cadenceWith(ctx, account, address).catch(() => undefined)));
    return p;
  };
  const cadence = (await Promise.all(sensitive.slice(0, 5).map((c) => lookup(c.address)))).filter((c): c is Cadence => c !== undefined);
  const words = wordCount(text);
  const flags: string[] = [];
  if (words > LONG_WORDS) flags.push(`long: ${words} words. Bailiffs, lawyers and administrations often put long emails aside; keep it to the one or two points that matter (about ${LONG_WORDS} words at most)`);
  for (const c of cadence) {
    if (c.unanswered_in_a_row >= 2 || c.sent_last_7_days >= 2) {
      flags.push(
        `frequent: ${c.address} already got ${c.sent_last_7_days} email(s) from this account in 7 days (${c.unanswered_in_a_row} since their last answer). Several emails in a short time make such people disengage; wait for their answer, call, or merge the points into one short mail`,
      );
    }
  }
  const tone = toneMarkers(subject, text);
  if (tone.length) flags.push(`tone: ${tone.map((t) => `"${t}"`).join(', ')} can read as a reproach or an ultimatum`);
  const who = sensitive.map((c) => `${c.address} (${c.why}${c.note ? `: ${c.note}` : ''})`).join('; ');
  return {
    sensitive,
    cadence,
    words,
    flags,
    ask:
      `Before this goes out, show the user the final text and a short risk review: what the user depends on ${sensitive.length > 1 ? 'these people' : 'this person'} for (${who}), ` +
      'how the wording and timing may be received and what they could do (withdraw, delay, bill, stop answering), the flags above, and a courteous version that keeps what matters, even if the user asked for a firm tone. ' +
      'Send it only once the user has confirmed that exact text: gmail_send_draft (now) or gmail_schedule_send (at a later time) with reviewed_by_user: true and this review_token. Never from a scheduled task or without the user.',
  };
}

export const reviewedByUserParam = z
  .boolean()
  .optional()
  .describe(
    'For mail to sensitive contacts (bailiffs, lawyers, notaries, courts, administrations, insurers, property managers, the user\'s own list, people a follow-up waits on): true only after the user saw this exact final text and the risk review in this conversation and confirmed sending. Never from a scheduled task.',
  );

export const reviewTokensParam = z
  .array(z.string().min(1))
  .max(25)
  .optional()
  .describe('With reviewed_by_user: the review_token of each draft to sensitive contacts, from the review (a draft edited since needs a new review).');

/**
 * A refusal for a notification Google would email to sensitive contacts (a Drive share, a Calendar invitation or
 * reply); undefined when none is sensitive or the user reviewed it.
 */
export function notificationRefusal(ctx: ToolContext, addresses: string[], what: string, reviewed: boolean | undefined, howToAvoid: string): string | undefined {
  if (reviewed) return undefined;
  const sensitive = sensitiveRecipients(
    ctx,
    addresses.filter((a) => a.includes('@')).map((email) => ({ email })),
  );
  if (!sensitive.length) return undefined;
  ctx.log.info('notification held for review', { categories: [...new Set(sensitive.map((c) => c.category))].join(',') });
  return (
    `Not done: ${what} would email ${sensitive.map((c) => `${c.address} (${c.why})`).join(', ')}. ` +
    `Show the user what they will receive and the risks (how it may be received, how often they were written to lately), then call again with reviewed_by_user: true once the user confirms, or ${howToAvoid}.`
  );
}

// ---------------------------------------------------------------------------
// sensitive_contacts

export const sensitiveContactsTool: ToolDefinition = defineTool({
  name: 'sensitive_contacts',
  title: 'Sensitive contacts',
  description:
    'Shows or changes who counts as a sensitive contact: mail to them is never sent directly; it is saved as a draft and goes out only with gmail_send_draft reviewed_by_user: true, after the user saw it with a risk review (who they are, how often they were written to lately, length, wording). ' +
    `Built-in categories: ${SENSITIVE_CATEGORIES.join(', ')} (recognised from the address), plus anyone an open follow-up waits on. ` +
    'mark adds addresses or whole domains ("cabinet-dupont.fr") with an optional note; exempt takes them out of every category; forget returns them to the built-in rules. check tells whether addresses count, and why. With nothing given, lists the user\'s entries.',
  inputSchema: {
    mark: z.array(z.string().min(3)).max(50).optional().describe('Addresses or domains to treat as sensitive.'),
    note: z.string().max(200).optional().describe('With mark: why, e.g. "handles the lease dispute".'),
    exempt: z.array(z.string().min(3)).max(50).optional().describe('Addresses or domains never to treat as sensitive.'),
    forget: z.array(z.string().min(3)).max(50).optional().describe('Entries to take off both lists.'),
    check: z.array(z.string().min(3)).max(50).optional().describe('Addresses to classify.'),
    account: accountParam.optional().describe('With check: also give the recent cadence with each address in this account.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const store = ctx.sensitive;
    if (!store) throw new ToolInputError('This server keeps no list of sensitive contacts.');
    let list: SensitiveList;
    try {
      list = store.get();
      if (args.forget?.length) list = store.forget(args.forget);
      if (args.exempt?.length) list = store.exempt(args.exempt);
      if (args.mark?.length) list = store.mark(args.mark, args.note);
    } catch (err) {
      if (err instanceof SensitiveContactsError) throw new ToolInputError(err.message);
      throw err;
    }
    const checked = args.check?.length
      ? await Promise.all(
          args.check.map(async (raw) => {
            const address = raw.trim().toLowerCase();
            const c = classify(ctx, address, list);
            const cadence = c && args.account ? await cadenceWith(ctx, args.account, address).catch(() => undefined) : undefined;
            return { address, sensitive: c !== undefined, category: c?.category, why: c?.why, note: c?.note, cadence };
          }),
        )
      : undefined;
    ctx.log.info('sensitive contacts', { marked: list.marked.length, exempt: list.exempt.length, checked: checked?.length });
    return jsonResult({
      marked: list.marked.map((m) => ({ entry: m.entry, note: m.note })),
      exempt: list.exempt,
      categories: SENSITIVE_CATEGORIES,
      checked,
      limit: MAX_ENTRIES,
    });
  },
});
