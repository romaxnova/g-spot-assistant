/**
 * The daily follow-up digest: once a day, at the owner's chosen time, the
 * connector puts a "Follow-ups" email into one linked account's inbox, so what
 * waits (a reply arrived for a tracked item, mail owed, drafts left unsent,
 * quote requests half answered) reaches the owner without asking Claude.
 *
 * The email is inserted (users.messages.insert into INBOX, UNREAD, IMPORTANT),
 * never sent: it goes to no one, leaves nothing in Sent and needs no more than
 * gmail.modify. Each new digest archives the previous one (INBOX removed, kept
 * in All Mail): it only repeated it, and digests piling up in the inbox would
 * take the places of the inbox listing the engine reads owed mail from. Its
 * content comes from the follow-up engine at delivery time and is never
 * stored: the database keeps the settings (aliases, time, zone, language), the
 * last run's date and status and the last digest's message id, nothing
 * personal.
 *
 * DigestScheduler.tick() is called every few minutes by the server. It runs at
 * most once per local day, once the configured time has passed (a deploy at
 * that time catches up on the next tick; a time in the last minutes of the
 * day, missed between two ticks, just after midnight). A failed run is retried
 * on the next ticks, at most MAX_RETRIES times that day; a day with nothing to
 * report sends nothing (its status says when older mail of a busy mailbox was
 * not read). It reads all the engine reads (MAX_THREADS_READ threads per
 * listing), three requests at a time per mailbox: unattended, it has the
 * time, and stays near Gmail's per-user rate. Each day's digest carries a
 * Message-ID of its own, so a retry first looks for the copy an earlier try
 * may have left in the inbox before failing (a timeout once Gmail had it)
 * instead of inserting a second.
 * Without a chosen inbox, the digest goes to the first linked account with
 * Gmail, whatever its state: when that inbox cannot take it, the run fails
 * rather than go to someone else's. Logs carry counts, aliases and error
 * names only.
 */
import { ALIAS_RE, type AccountStore } from '../accounts.js';
import type { Db } from '../db.js';
import { AccountError, GoogleApiError } from '../google/client.js';
import type { Logger } from '../log.js';
import type { ToolContext } from '../mcp/registry.js';
import { oneLine } from '../mcp/text.js';
import { isKnownTimeZone, todayIn } from '../mcp/tools/cross.js';
import { gmailWebUrl } from '../mcp/tools/gmail-identity.js';
import { buildMimeMessage, encodeBase64Url, formatAddress, parseAddresses } from '../mcp/tools/gmail-mime.js';
import { encodeId, SERVICE } from '../mcp/tools/gmail.js';
import { esc } from '../web/html.js';
import { computeFollowups, MAX_THREADS_READ, normalizeSubject, type DraftRow, type FollowupReport, type TrackedRow } from './engine.js';

export const DIGEST_LANGS = ['en', 'fr'] as const;
export const DIGEST_FREQUENCIES = ['daily', 'weekly'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];
/** ISO weekdays, Monday first (1). */
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type DigestLang = (typeof DIGEST_LANGS)[number];

/** Display name of the digest's From. */
export const DIGEST_SENDER = 'Follow-ups';
export const DIGEST_LABELS = ['INBOX', 'UNREAD', 'IMPORTANT'] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A Gmail message id. */
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Mail unanswered (either way) for longer is left out of the digest: past three weeks it was dealt with otherwise, or is a chat's matter. */
export const DIGEST_WAITING_MAX_DAYS = 21;
/**
 * Minutes after the configured time during which a digest missed before midnight is still sent the next day: the
 * server ticks every few minutes, so a time such as 23:58 can fall after the day's last tick.
 */
export const CATCH_UP_MINUTES = 15;
/** Rows per section of the email; the rest is counted ("+N more"). */
const MAX_ROWS = 15;
/**
 * Bytes of HTML rows at most: Gmail clips a body past about 102 KB ("[Message clipped]"), hiding what follows. Rows
 * past it are counted like those past MAX_ROWS; headings and the footer fit in the margin.
 */
const MAX_HTML_BYTES = 90_000;
/** Names per list of a batch. */
const MAX_NAMES = 6;
/** A failed scheduled run is retried on the next ticks, at most this many times a day. */
export const MAX_RETRIES = 3;
/**
 * Gmail requests at a time per mailbox. Reading MAX_THREADS_READ threads per listing, and then asking whether each
 * row was answered another way (a search, a few message reads, in up to every linked mailbox), costs up to about
 * 7,500 quota units a mailbox (within the 15,000 a minute per user): three at a time keeps the run near the 250 a
 * second at usual latencies. A full run of four busy mailboxes can take a minute or two, which still fits claude.ai's
 * 240 s when followup_digest sends one now; the scheduled run has no such limit.
 */
const DIGEST_CONCURRENCY = 3;
const MAX_ACCOUNTS = 20;

export interface DigestSettings {
  enabled: boolean;
  /** Every day, or once a week on `weekday`. */
  frequency: DigestFrequency;
  weekday: Weekday;
  /** Local time of day the digest is due, HH:MM. */
  time: string;
  /** IANA zone the time and the day are read in. */
  timezone: string;
  /** Aliases whose mail is read; empty: every linked Gmail account. */
  accounts: string[];
  /** Alias whose inbox receives the digest; unset: the first linked account with Gmail, whatever its state (see digestInbox). */
  deliver_to?: string;
  lang: DigestLang;
  /** YYYY-MM-DD (in timezone) of the day whose scheduled digest is done: delivered, or nothing to report. */
  last_run_date?: string;
  /**
   * "delivered 7 items", "nothing to report", "nothing found in recent mail (older mail not read)", "failed: GoogleApiError",
   * "failed: me has no Gmail" (scheduled or Send now; aliases, never addresses).
   */
  last_status?: string;
  /** Epoch ms the last run (finished or failed, scheduled or Send now) ended. */
  last_run_at?: number;
  /** Day of the failed scheduled runs counted in attempts. */
  attempt_date?: string;
  attempts?: number;
  /** The latest digest put into an inbox, archived when the next one arrives. */
  last_digest?: { alias: string; message_id: string };
}

/** The owner's choices, as the admin form gives them; null clears an optional field. */
export interface DigestSettingsInput {
  enabled?: boolean;
  frequency?: string;
  weekday?: string;
  time?: string;
  timezone?: string | null;
  accounts?: string[];
  deliver_to?: string | null;
  lang?: string;
}

type RunState = Partial<Pick<DigestSettings, 'last_run_date' | 'last_status' | 'last_run_at' | 'attempt_date' | 'attempts' | 'last_digest'>>;

/** Settings as stored: the time zone only when the owner chose one (otherwise the configured default applies). */
type Stored = Partial<DigestSettings>;

/** A setting the store refuses, with a message meant for the owner. */
export class DigestSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestSettingsError';
  }
}

/** A run that cannot go ahead; its message (fixed text, nothing personal) becomes the status. */
class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestError';
  }
}

const DEFAULTS = { enabled: false, frequency: 'daily' as DigestFrequency, weekday: 'monday' as Weekday, time: '08:00', lang: 'en' as DigestLang };

function aliasList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()))].filter((v) => ALIAS_RE.test(v)).slice(0, MAX_ACCOUNTS);
}

/** The known fields of a stored row, each kept only when well formed (a damaged row reads as the defaults). */
function parseStored(json: string): Stored {
  let raw: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(json);
    raw = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const str = (k: string, ok: (v: string) => boolean) => (typeof raw[k] === 'string' && ok(raw[k] as string) ? (raw[k] as string) : undefined);
  const num = (k: string) => (typeof raw[k] === 'number' && Number.isFinite(raw[k]) ? (raw[k] as number) : undefined);
  const digest = raw['last_digest'] as { alias?: unknown; message_id?: unknown } | null | undefined;
  const lastDigest =
    digest && typeof digest === 'object' && typeof digest.alias === 'string' && ALIAS_RE.test(digest.alias) && typeof digest.message_id === 'string' && MESSAGE_ID_RE.test(digest.message_id)
      ? { alias: digest.alias, message_id: digest.message_id }
      : undefined;
  return {
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : undefined,
    frequency: str('frequency', (v) => (DIGEST_FREQUENCIES as readonly string[]).includes(v)) as DigestFrequency | undefined,
    weekday: str('weekday', (v) => (WEEKDAYS as readonly string[]).includes(v)) as Weekday | undefined,
    time: str('time', (v) => TIME_RE.test(v)),
    timezone: str('timezone', isKnownTimeZone),
    accounts: aliasList(raw['accounts']),
    deliver_to: str('deliver_to', (v) => ALIAS_RE.test(v)),
    lang: str('lang', (v) => (DIGEST_LANGS as readonly string[]).includes(v)) as DigestLang | undefined,
    last_run_date: str('last_run_date', (v) => DATE_RE.test(v)),
    last_status: str('last_status', (v) => v.length <= 120),
    last_run_at: num('last_run_at'),
    attempt_date: str('attempt_date', (v) => DATE_RE.test(v)),
    attempts: num('attempts'),
    last_digest: lastDigest,
  };
}

/** The owner's input checked and normalised; a DigestSettingsError names the first problem. */
function validInput(input: DigestSettingsInput): Stored {
  const out: Stored = {};
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  if (input.frequency !== undefined) {
    const f = input.frequency.trim().toLowerCase();
    if (!(DIGEST_FREQUENCIES as readonly string[]).includes(f)) throw new DigestSettingsError(`Frequency must be one of: ${DIGEST_FREQUENCIES.join(', ')}.`);
    out.frequency = f as DigestFrequency;
  }
  if (input.weekday !== undefined) {
    const w = input.weekday.trim().toLowerCase();
    if (!(WEEKDAYS as readonly string[]).includes(w)) throw new DigestSettingsError(`Day must be one of: ${WEEKDAYS.join(', ')}.`);
    out.weekday = w as Weekday;
  }
  if (input.time !== undefined) {
    const time = input.time.trim();
    if (!TIME_RE.test(time)) throw new DigestSettingsError(`Time must be written HH:MM, from 00:00 to 23:59 (got "${input.time.slice(0, 20)}").`);
    out.time = time;
  }
  if (input.timezone !== undefined) {
    const tz = input.timezone?.trim() ?? '';
    if (tz && !isKnownTimeZone(tz)) throw new DigestSettingsError(`Unknown time zone "${tz.slice(0, 60)}": use an IANA name such as Europe/Paris.`);
    out.timezone = tz || undefined;
  }
  if (input.accounts !== undefined) {
    const bad = input.accounts.find((a) => !ALIAS_RE.test(a.trim().toLowerCase()));
    if (bad !== undefined) throw new DigestSettingsError(`"${bad.slice(0, 40)}" is not an account alias.`);
    if (input.accounts.length > MAX_ACCOUNTS) throw new DigestSettingsError(`At most ${MAX_ACCOUNTS} accounts.`);
    out.accounts = aliasList(input.accounts);
  }
  if (input.deliver_to !== undefined) {
    const alias = input.deliver_to?.trim().toLowerCase() ?? '';
    if (alias && !ALIAS_RE.test(alias)) throw new DigestSettingsError(`"${alias.slice(0, 40)}" is not an account alias.`);
    out.deliver_to = alias || undefined;
  }
  if (input.lang !== undefined) {
    if (!(DIGEST_LANGS as readonly string[]).includes(input.lang)) throw new DigestSettingsError(`Language must be one of: ${DIGEST_LANGS.join(', ')}.`);
    out.lang = input.lang as DigestLang;
  }
  return out;
}

/** The digest's settings and last run, one JSON row (aliases, times, statuses and a message id only: nothing to encrypt). */
export class DigestSettingsStore {
  constructor(
    private readonly db: Db,
    private readonly defaultTimezone: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS followup_digest_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  get(): DigestSettings {
    const s = this.read();
    return {
      enabled: s.enabled ?? DEFAULTS.enabled,
      frequency: s.frequency ?? DEFAULTS.frequency,
      weekday: s.weekday ?? DEFAULTS.weekday,
      time: s.time ?? DEFAULTS.time,
      timezone: s.timezone ?? this.defaultTimezone,
      accounts: s.accounts ?? [],
      deliver_to: s.deliver_to,
      lang: s.lang ?? DEFAULTS.lang,
      last_run_date: s.last_run_date,
      last_status: s.last_status,
      last_run_at: s.last_run_at,
      attempt_date: s.attempt_date,
      attempts: s.attempts,
      last_digest: s.last_digest,
    };
  }

  /** Saves the owner's choices (fields left out keep their value). Throws DigestSettingsError for invalid input. */
  update(input: DigestSettingsInput): DigestSettings {
    this.write({ ...this.read(), ...validInput(input) });
    return this.get();
  }

  /** Records how a run went: the fields given (undefined clears one), the others kept. */
  record(state: RunState): DigestSettings {
    this.write({ ...this.read(), ...state });
    return this.get();
  }

  private read(): Stored {
    const row = this.db.prepare('SELECT settings_json FROM followup_digest_settings WHERE id = 1').get() as { settings_json: string } | undefined;
    return row ? parseStored(row.settings_json) : {};
  }

  private write(s: Stored): void {
    this.db
      .prepare(
        `INSERT INTO followup_digest_settings (id, settings_json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(s), Date.now());
  }
}

// ---------------------------------------------------------------------------
// Rendering

export interface DigestRenderOptions {
  lang: DigestLang;
  /** Zone the date in the subject and "today" are read in. */
  timezone: string;
  /** Epoch ms the digest stands for. */
  now: number;
  /** The admin page, linked from the footer to change the settings. */
  adminUrl?: string;
  /** A linked account's address, to link tracked items to the thread they watch. */
  emailOf?: (alias: string) => string | undefined;
}

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

type Plural = (n: number) => string;

interface Strings {
  locale: string;
  prefix: string;
  allClear: string;
  allClearBody: string;
  /** Nothing found, but only the recent mail of a busy mailbox was read. */
  nothingFound: string;
  nothingFoundBody: string;
  count: { ready: Plural; due: Plural; owed: Plural; drafts: Plural; tracking: Plural; waiting: Plural; batches: Plural; handled: Plural; unchecked: Plural };
  title: { ready: string; due: string; owed: string; drafts: string; tracking: string; batches: string; waiting: string; handled: string; unchecked: string };
  /** A ready item the user already wrote back on. */
  wroteBack: (who: string | undefined) => string;
  /** Several drafts of one message (a mail merge). */
  draftGroup: (n: number, to: string | undefined, saved: string) => string;
  /** Drafts in threads already answered. */
  supersededHead: (n: number) => string;
  supersededNote: string;
  more: Plural;
  noSubject: string;
  arrived: (who: string | undefined, subject: string | undefined, attachment: boolean) => string;
  next: (step: string) => string;
  dueToday: string;
  overdue: (day: string, late: number) => string;
  /** A tracked item still awaited: how long, from whom, by when. */
  since: Plural;
  from: (who: string) => string;
  dueOn: (day: string) => string;
  /** Mail from an awaited person that did not count: elsewhere, or without the document expected. */
  otherMail: (who: string | undefined, reason: 'other_conversation' | 'no_attachment') => string;
  /** Calendar days since a message, in the digest's zone: today, yesterday, N days. */
  days: Plural;
  to: (who: string) => string;
  noRecipient: string;
  saved: Plural;
  batch: (sent: number, replied: number, toAnswer: number, silent: number) => string;
  /** Labels of a batch's name lists, colon included. */
  replied: string;
  noReply: string;
  bounced: string;
  autoReply: string;
  askClaude: string;
  settings: (url: string) => string;
  settingsLink: string;
  /** Accounts with more mail than the engine reads per listing: their older mail was not looked at. */
  partial: (accounts: string) => string;
}

const pl = (n: number, one: string, many: string) => (n === 1 ? one : many);

const STRINGS: Record<DigestLang, Strings> = {
  en: {
    locale: 'en-GB',
    prefix: 'Follow-ups',
    allClear: 'all clear',
    allClearBody: 'Nothing needs following up today.',
    nothingFound: 'nothing found in recent mail',
    nothingFoundBody: 'Nothing found in the recent mail read.',
    count: {
      ready: (n) => `${n} ready`,
      due: (n) => `${n} due`,
      owed: (n) => `${n} waiting for you`,
      drafts: (n) => `${n} unsent ${pl(n, 'draft', 'drafts')}`,
      tracking: (n) => `${n} still awaited`,
      waiting: (n) => `${n} unanswered`,
      batches: (n) => `${n} ${pl(n, 'batch', 'batches')} pending`,
      handled: (n) => `${n} probably done`,
      unchecked: (n) => `${n} ${pl(n, 'account', 'accounts')} not checked`,
    },
    title: {
      ready: 'Ready to act',
      due: 'Overdue or due today',
      owed: 'People waiting for your reply',
      drafts: 'Unsent drafts',
      tracking: 'Still waiting on',
      batches: 'Batches',
      waiting: 'No answer yet',
      handled: 'Probably done: close them',
      unchecked: 'Not checked',
    },
    wroteBack: (who) => `you wrote back${who ? ` to ${who}` : ''} since: close it if it is done`,
    draftGroup: (n, to, saved) => `${n} drafts${to ? `, to ${to}` : ''} · ${saved}`,
    supersededHead: (n) => `${n} ${pl(n, 'draft', 'drafts')} in threads you already answered`,
    supersededNote: 'Probably leftovers: delete them.',
    more: (n) => `+${n} more`,
    noSubject: '(no subject)',
    arrived: (who, subject, attachment) => `${who ? `from ${who}` : 'new message'}${subject ? `: ${subject}` : ''}${attachment ? ' (attachment)' : ''}`,
    next: (step) => `Next: ${step}`,
    dueToday: 'due today',
    overdue: (day, late) => `due ${day}, ${late} ${pl(late, 'day', 'days')} late`,
    since: (n) => (n <= 0 ? 'since today' : n === 1 ? 'since yesterday' : `for ${n} days`),
    from: (who) => `from ${who}`,
    dueOn: (day) => `due ${day}`,
    otherMail: (who, reason) =>
      `${reason === 'no_attachment' ? 'new mail' : 'new mail in another conversation'}${who ? ` from ${who}` : ''}${reason === 'no_attachment' ? ', without the document' : ''}: worth a look`,
    days: (n) => (n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days`),
    to: (who) => `to ${who}`,
    noRecipient: 'no recipient',
    saved: (n) => (n <= 0 ? 'saved today' : n === 1 ? 'saved yesterday' : `saved ${n} days ago`),
    batch: (sent, replied, toAnswer, silent) => `${sent} sent · ${replied} replied${toAnswer ? ` (${toAnswer} to answer)` : ''} · ${silent} no reply`,
    replied: 'Replied:',
    noReply: 'No reply:',
    bounced: 'bounced',
    autoReply: 'auto-reply',
    askClaude: 'Ask Claude: go through my follow-ups',
    settings: (url) => `Change the daily digest: ${url}`,
    settingsLink: 'Change the daily digest',
    partial: (accounts) => `Only the most recent mail of ${accounts} was read: older mail may need following up too.`,
  },
  fr: {
    locale: 'fr-FR',
    prefix: 'Suivi',
    allClear: 'rien à signaler',
    allClearBody: "Rien à suivre aujourd'hui.",
    nothingFound: 'rien dans le courrier récent',
    nothingFoundBody: 'Rien à suivre dans le courrier récent lu.',
    count: {
      ready: (n) => `${n} ${pl(n, 'prêt', 'prêts')}`,
      due: (n) => `${n} à échéance`,
      owed: (n) => `${n} ${pl(n, 'attend', 'attendent')} votre réponse`,
      drafts: (n) => `${n} ${pl(n, 'brouillon non envoyé', 'brouillons non envoyés')}`,
      tracking: (n) => `${n} en attente`,
      waiting: (n) => `${n} sans réponse`,
      batches: (n) => `${n} ${pl(n, 'envoi groupé', 'envois groupés')} en cours`,
      handled: (n) => `${n} sans doute ${pl(n, 'réglé', 'réglés')}`,
      unchecked: (n) => `${n} ${pl(n, 'compte non vérifié', 'comptes non vérifiés')}`,
    },
    title: {
      ready: 'Prêt à traiter',
      due: "En retard ou à faire aujourd'hui",
      owed: 'Ils attendent votre réponse',
      drafts: 'Brouillons non envoyés',
      tracking: 'En attente de',
      batches: 'Envois groupés',
      waiting: 'Toujours sans réponse',
      handled: 'Sans doute réglé : à clore',
      unchecked: 'Non vérifié',
    },
    wroteBack: (who) => `vous avez répondu${who ? ` à ${who}` : ''} depuis : à clore si c'est réglé`,
    draftGroup: (n, to, saved) => `${n} brouillons${to ? `, à ${to}` : ''} · ${saved}`,
    supersededHead: (n) => `${n} ${pl(n, 'brouillon', 'brouillons')} dans des conversations déjà répondues`,
    supersededNote: 'Sans doute des restes : à supprimer.',
    more: (n) => `+${n} ${pl(n, 'autre', 'autres')}`,
    noSubject: '(sans objet)',
    arrived: (who, subject, attachment) => `${who ? `de ${who}` : 'nouveau message'}${subject ? ` : ${subject}` : ''}${attachment ? ' (pièce jointe)' : ''}`,
    next: (step) => `Ensuite : ${step}`,
    dueToday: "à faire aujourd'hui",
    overdue: (day, late) => `échéance ${day}, ${late} ${pl(late, 'jour', 'jours')} de retard`,
    since: (n) => (n <= 0 ? "depuis aujourd'hui" : n === 1 ? 'depuis hier' : `depuis ${n} jours`),
    from: (who) => `de ${who}`,
    dueOn: (day) => `échéance ${day}`,
    otherMail: (who, reason) =>
      `${reason === 'no_attachment' ? 'nouveau message' : 'nouveau message dans une autre conversation'}${who ? ` de ${who}` : ''}${reason === 'no_attachment' ? ', sans le document' : ''} : à regarder`,
    days: (n) => (n <= 0 ? "aujourd'hui" : n === 1 ? 'hier' : `${n} jours`),
    to: (who) => `à ${who}`,
    noRecipient: 'sans destinataire',
    saved: (n) => (n <= 0 ? "enregistré aujourd'hui" : n === 1 ? 'enregistré hier' : `enregistré il y a ${n} jours`),
    batch: (sent, replied, toAnswer, silent) =>
      `${sent} ${pl(sent, 'envoyé', 'envoyés')} · ${replied} ${pl(replied, 'réponse', 'réponses')}${toAnswer ? ` (${toAnswer} à traiter)` : ''} · ${silent} sans réponse`,
    replied: 'Ont répondu :',
    noReply: 'Sans réponse :',
    bounced: 'non distribué',
    autoReply: 'réponse automatique',
    askClaude: 'Demandez à Claude : « passe en revue mes suivis »',
    settings: (url) => `Modifier le récapitulatif quotidien : ${url}`,
    settingsLink: 'Modifier le récapitulatif quotidien',
    partial: (accounts) => `Seul le courrier le plus récent de ${accounts} a été lu : du courrier plus ancien peut aussi demander un suivi.`,
  },
};

/** One row of a section, written once and rendered as text and HTML. */
interface Line {
  /** Alias, shown when the digest covers several accounts. */
  account?: string;
  head: string;
  meta?: string;
  note?: string;
  /** HTML only: the start of the message. */
  snippet?: string;
  url?: string;
  /** Batches: names, each linked to its thread. */
  groups?: { label: string; names: { name: string; url: string }[]; more: number }[];
}

type SectionKey = keyof Strings['title'];

interface Section {
  key: SectionKey;
  title: string;
  /** Lines in the section. */
  total: number;
  /** What the subject counts when it is not the lines (drafts: grouped lines, counted one by one). */
  count?: number;
  lines: Line[];
}

/** One line of text, at most `max` characters. */
function clipText(value: string | undefined, max: number): string | undefined {
  const v = value === undefined ? '' : oneLine(value);
  if (!v) return undefined;
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** People of an address line as one reads them: names (else addresses), at most `max`, "+N" for the others. */
function names(line: string | undefined, max = 3): string | undefined {
  if (!line) return undefined;
  const tail = / \+(\d+) more$/.exec(line);
  const all = parseAddresses(tail ? line.slice(0, tail.index) : line)
    .map((a) => oneLine(a.name || a.email))
    .filter(Boolean);
  if (!all.length) return undefined;
  const more = all.length - max + (tail ? Number(tail[1]) : 0);
  return `${all.slice(0, max).join(', ')}${more > 0 ? ` +${more}` : ''}`;
}

/** The first person of an address line, by name (else address). */
function firstName(line: string | undefined): string | undefined {
  const a = parseAddresses(line)[0];
  return a && (oneLine(a.name || a.email) || undefined);
}

function dayLabel(lang: DigestLang, at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(STRINGS[lang].locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(at);
}

/** Days from one YYYY-MM-DD to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Rows the digest shows, per section; tracked items still awaited are listed too, so what is outstanding stays in view. */
function buildSections(report: FollowupReport, o: DigestRenderOptions): Section[] {
  const t = STRINGS[o.lang];
  const today = todayIn(o.timezone, new Date(o.now));
  const several = report.accounts.length > 1;
  const acct = (alias: string) => (several ? alias : undefined);
  const watchedUrl = (r: TrackedRow) => {
    const w = r.watch_threads?.[0];
    const email = w && o.emailOf?.(w.account);
    return w && email ? gmailWebUrl(email, 'thread', w.thread_id) : undefined;
  };
  const head = (v: string | undefined) => clipText(v, 160) ?? t.noSubject;
  // Calendar days in the digest's zone, whatever zone the report was made in: in a morning digest, last afternoon's
  // mail (19 hours old) is "yesterday", not "today".
  const ago = (at: string, elapsed: number) => {
    const time = Date.parse(at);
    return Number.isFinite(time) ? Math.max(0, daysBetween(todayIn(o.timezone, new Date(time)), today)) : elapsed;
  };

  const ready: Line[] = report.tracked
    .filter((r) => r.status === 'ready' && !r.handled)
    .map((r) => ({
      account: acct(r.account),
      head: head(r.title),
      meta: r.arrived && clipText(t.arrived(names(r.arrived.from, 2), clipText(r.arrived.subject, 120), !!r.arrived.has_attachments), 200),
      note: r.next_step && clipText(t.next(r.next_step), 300),
      url: r.arrived?.web_url ?? watchedUrl(r),
    }));
  const due: Line[] = report.tracked
    .filter((r) => r.status === 'overdue' || r.status === 'due')
    .map((r) => ({
      account: acct(r.account),
      head: head(r.title),
      meta: r.status === 'due' || !r.due ? t.dueToday : t.overdue(dayLabel(o.lang, new Date(`${r.due}T12:00:00Z`), 'UTC'), daysBetween(r.due, today)),
      note: r.next_step && clipText(t.next(r.next_step), 300),
      url: watchedUrl(r),
    }));
  // Nothing to do yet, but this is the reminder of what is outstanding (the lawyer's document, the quote, ...).
  const tracking: Line[] = report.tracked
    .filter((r) => r.status === 'waiting')
    .map((r) => {
      const who = r.waiting_on?.length ? names(r.waiting_on.join(', '), 2) : undefined;
      const other = r.other_mail && clipText(t.otherMail(names(r.other_mail.from, 2), r.other_mail.reason), 200);
      return {
        account: acct(r.account),
        head: head(r.title),
        meta: [who ? t.from(who) : '', t.since(ago(r.created_at, r.age_days)), r.due ? t.dueOn(dayLabel(o.lang, new Date(`${r.due}T12:00:00Z`), 'UTC')) : '']
          .filter(Boolean)
          .join(' · '),
        note: [other, r.next_step && clipText(t.next(r.next_step), 300)].filter(Boolean).join(' — ') || undefined,
        url: r.other_mail?.web_url ?? watchedUrl(r),
      };
    });
  const owed: Line[] = report.owed.map((r) => ({
    account: acct(r.account),
    head: head(r.subject),
    meta: [names(r.from, 2), t.days(ago(r.received_at, r.days))].filter(Boolean).join(' · '),
    snippet: clipText(r.snippet, 140),
    url: r.web_url,
  }));
  const handled: Line[] = report.tracked
    .filter((r) => r.status === 'ready' && r.handled)
    .map((r) => ({ account: acct(r.account), head: head(r.title), meta: t.wroteBack(names(r.arrived?.from, 1)), url: r.arrived?.web_url ?? watchedUrl(r) }));
  // A mail merge left unsent is one line, not one per recipient; drafts in threads already answered are one line too.
  const live = report.drafts.filter((r) => !r.superseded);
  const groups = new Map<string, DraftRow[]>();
  for (const r of live) {
    // Only new messages are one merge; replies with the same subject belong to different conversations.
    const fresh = !r.thread_id || r.thread_id === r.message_id;
    const key = fresh ? `${r.account}\n${normalizeSubject(r.subject ?? '') || r.draft_id}` : `${r.account}\n#${r.draft_id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const drafts: Line[] = [...groups.values()].map((g) => {
    const r = g[0]!;
    if (g.length === 1) {
      const to = names(r.to);
      return { account: acct(r.account), head: head(r.subject), meta: `${to ? t.to(to) : t.noRecipient} · ${t.saved(ago(r.saved_at, r.days))}`, url: r.web_url };
    }
    const oldest = g.reduce((a, b) => (a.saved_at < b.saved_at ? a : b));
    return { account: acct(r.account), head: head(r.subject), meta: t.draftGroup(g.length, names(g.map((x) => x.to ?? '').filter(Boolean).join(', ')), t.saved(ago(oldest.saved_at, oldest.days))), url: r.web_url };
  });
  const superseded = report.drafts.filter((r) => r.superseded);
  if (superseded.length) {
    drafts.push({
      account: [...new Set(superseded.map((r) => acct(r.account)))].join(', ') || undefined,
      head: t.supersededHead(superseded.length),
      meta: clipText(superseded.slice(0, 5).map((r) => r.subject ?? t.noSubject).join(' · '), 200),
      note: t.supersededNote,
      url: superseded[0]!.web_url,
    });
  }
  const batches: Line[] = report.batches.map((b) => {
    const toAnswer = b.replied.filter((r) => !r.answered);
    const list = (label: string, rows: { who?: string; web_url: string }[], total: number) => {
      const shown = rows.slice(0, MAX_NAMES).map((r) => ({ name: clipText(firstName(r.who), 60) ?? '?', url: r.web_url }));
      return { label, names: shown, more: Math.max(0, total - shown.length) };
    };
    return {
      account: acct(b.account),
      head: head(b.subject),
      meta: t.batch(b.sent, b.replied_count, toAnswer.length, b.no_reply_count),
      url: (toAnswer[0] ?? b.no_reply[0] ?? b.replied[0])?.web_url,
      groups: [list(t.replied, b.replied, b.replied_count), list(t.noReply, b.no_reply, b.no_reply_count)].filter((g) => g.names.length),
    };
  });
  const waiting: Line[] = report.waiting.map((r) => {
    const to = names(r.to);
    const flags = [r.bounced ? t.bounced : '', r.auto_reply ? t.autoReply : ''].filter(Boolean);
    return { account: acct(r.account), head: head(r.subject), meta: [to ? t.to(to) : '', t.days(ago(r.sent_at, r.days_waiting)), ...flags].filter(Boolean).join(' · '), url: r.web_url };
  });
  const unchecked: Line[] = (report.errors ?? []).map((e) => ({ head: e.account, meta: clipText(e.error, 240), url: o.adminUrl }));

  // What could not be checked comes first: it says the rest is incomplete, and is never clipped away.
  const all: [SectionKey, Line[]][] = [
    ['unchecked', unchecked],
    ['ready', ready],
    ['due', due],
    ['owed', owed],
    ['drafts', drafts],
    ['tracking', tracking],
    ['batches', batches],
    ['waiting', waiting],
    ['handled', handled],
  ];
  return all.map(([key, lines]) => ({ key, title: t.title[key], total: lines.length, count: key === 'drafts' ? report.drafts.length : undefined, lines }));
}

/** Rows the digest would show (every open tracked item, owed, drafts, batches, waiting), before clipping. */
export function digestItemCount(report: FollowupReport): number {
  return (
    report.tracked.filter((r) => r.status !== 'done').length +
    report.owed.length +
    report.drafts.length +
    report.batches.length +
    report.waiting.length
  );
}

/** Only https links (Gmail's own, the admin page) are shown. */
function safeUrl(url: string | undefined): string | undefined {
  return url && /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : undefined;
}

/** A link for an href attribute, escaped; undefined for anything but https. */
function href(url: string | undefined): string | undefined {
  const safe = safeUrl(url);
  return safe && esc(safe);
}

const STYLE = {
  body: 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#202124;max-width:680px',
  h: 'font-size:15px;margin:18px 0 6px',
  count: 'color:#5f6368;font-weight:normal',
  ul: 'margin:0;padding-left:20px',
  li: 'margin:0 0 8px',
  link: 'color:#1a73e8;font-weight:bold;text-decoration:none',
  plainLink: 'color:#1a73e8;text-decoration:none',
  muted: 'color:#5f6368',
  small: 'color:#5f6368;font-size:13px',
  foot: 'color:#5f6368;font-size:12px;border-top:1px solid #dadce0;margin-top:22px;padding-top:10px',
};

function htmlLine(l: Line): string {
  const url = href(l.url);
  const account = l.account ? `<span style="${STYLE.muted}">[${esc(l.account)}]</span> ` : '';
  const head = url ? `<a href="${url}" style="${STYLE.link}">${esc(l.head)}</a>` : `<strong>${esc(l.head)}</strong>`;
  const meta = l.meta ? ` <span style="${STYLE.muted}">— ${esc(l.meta)}</span>` : '';
  const note = l.note ? `<br>${esc(l.note)}` : '';
  const snippet = l.snippet ? `<br><span style="${STYLE.small}">${esc(l.snippet)}</span>` : '';
  const groups = (l.groups ?? [])
    .map((g) => {
      const people = g.names.map((n) => {
        const link = href(n.url);
        return link ? `<a href="${link}" style="${STYLE.plainLink}">${esc(n.name)}</a>` : esc(n.name);
      });
      return `<br><span style="${STYLE.small}">${esc(g.label)}</span> ${people.join(', ')}${g.more ? ` <span style="${STYLE.muted}">+${g.more}</span>` : ''}`;
    })
    .join('');
  return `<li style="${STYLE.li}">${account}${head}${meta}${note}${snippet}${groups}</li>`;
}

function textLine(l: Line): string[] {
  const out = [`- ${l.account ? `[${l.account}] ` : ''}${l.head}${l.meta ? ` — ${l.meta}` : ''}`];
  if (l.note) out.push(`  ${l.note}`);
  for (const g of l.groups ?? []) out.push(`  ${g.label} ${g.names.map((n) => n.name).join(', ')}${g.more ? ` +${g.more}` : ''}`);
  const url = safeUrl(l.url);
  if (url) out.push(`  ${url}`);
  return out;
}

/** The digest email for a report: subject, plain text and HTML (everything from mail escaped), each section clipped. */
export function renderDigest(report: FollowupReport, opts: DigestRenderOptions): RenderedDigest {
  const t = STRINGS[opts.lang];
  const sections = buildSections(report, opts).filter((sec) => sec.total > 0);
  const n = (key: SectionKey) => {
    const sec = sections.find((x) => x.key === key);
    return sec ? (sec.count ?? sec.total) : 0;
  };
  const pick = (keys: (keyof Strings['count'])[]) => keys.filter((k) => n(k) > 0).map((k) => t.count[k](n(k)));
  // The subject names what asks for action; quieter sections only when nothing does.
  let parts = pick(['ready', 'due', 'owed', 'drafts']);
  if (!parts.length) parts = pick(['tracking', 'waiting', 'batches', 'handled']);
  if (!parts.length) parts = pick(['unchecked']);
  const day = dayLabel(opts.lang, new Date(opts.now), opts.timezone);
  // Nothing found is "all clear" only when every listing was read to its end.
  const partial = !!report.truncated?.length;
  const subject = `${t.prefix} — ${parts.length ? parts.join(', ') : partial ? t.nothingFound : t.allClear} (${day})`;

  const text: string[] = [subject, ''];
  const html: string[] = [];
  let room = MAX_HTML_BYTES;
  for (const sec of sections) {
    const shown: Line[] = [];
    const rows: string[] = [];
    for (const line of sec.lines.slice(0, MAX_ROWS)) {
      const row = htmlLine(line);
      room -= Buffer.byteLength(row);
      // Once full, the rest of every section is only counted.
      if (room < 0) break;
      shown.push(line);
      rows.push(row);
    }
    const more = sec.total - shown.length;
    text.push(`${sec.title} (${sec.count ?? sec.total})`, ...shown.flatMap(textLine), ...(more > 0 ? [`  ${t.more(more)}`] : []), '');
    html.push(
      `<h3 style="${STYLE.h}">${esc(sec.title)} <span style="${STYLE.count}">(${sec.count ?? sec.total})</span></h3><ul style="${STYLE.ul}">${rows.join('')}${
        more > 0 ? `<li style="${STYLE.li};list-style:none;${STYLE.muted}">${esc(t.more(more))}</li>` : ''
      }</ul>`,
    );
  }
  if (!sections.length) {
    const body = partial ? t.nothingFoundBody : t.allClearBody;
    text.push(body, '');
    html.push(`<p>${esc(body)}</p>`);
  }
  if (report.truncated?.length) {
    const line = t.partial(report.truncated.map((x) => x.account).join(', '));
    text.push(line, '');
    html.push(`<p style="${STYLE.small}">${esc(line)}</p>`);
  }
  const admin = href(opts.adminUrl);
  text.push('--', t.askClaude, ...(safeUrl(opts.adminUrl) ? [t.settings(opts.adminUrl!)] : []));
  html.push(`<p style="${STYLE.foot}">${esc(t.askClaude)}${admin ? `<br><a href="${admin}" style="${STYLE.plainLink}">${esc(t.settingsLink)}</a>` : ''}</p>`);
  return {
    subject,
    text: `${text.join('\n')}\n`,
    html: `<!doctype html><html lang="${opts.lang}"><head><meta charset="utf-8"></head><body><div style="${STYLE.body}">${html.join('')}</div></body></html>`,
  };
}

// ---------------------------------------------------------------------------
// Delivery

/**
 * Puts the digest into the account's inbox, unread and important, dated now (users.messages.insert): nothing is
 * sent. From "Follow-ups <the account's address>" to that address. Not retried here: a repeat could insert it twice
 * (the scheduler looks for the copy by its Message-ID first, see findDigest).
 */
export function deliverDigest(
  ctx: ToolContext,
  alias: string,
  digest: RenderedDigest,
  date = new Date(),
  messageId?: string,
): Promise<{ id?: string; threadId?: string }> {
  const email = ctx.google.resolve(alias, SERVICE).email;
  const mime = buildMimeMessage({ from: formatAddress(DIGEST_SENDER, email), to: [email], subject: digest.subject, text: digest.text, html: digest.html, date, messageId });
  return ctx.google.request<{ id?: string; threadId?: string }>(alias, SERVICE, {
    method: 'POST',
    url: '/messages',
    query: { internalDateSource: 'receivedTime' },
    body: { raw: encodeBase64Url(mime), labelIds: [...DIGEST_LABELS] },
    idempotent: false,
    touch: false,
  });
}

/** The Message-ID of a day's scheduled digest in an inbox: the same on every try of that day. */
export function digestMessageId(day: string, alias: string, host: string): string {
  return `<followups-digest.${day}.${alias}@${host}>`;
}

/** The id of the message with this Message-ID in the account (one messages.list, 5 quota units), if there is one. */
export async function findDigest(ctx: ToolContext, alias: string, messageId: string): Promise<string | undefined> {
  const found = await ctx.google.request<{ messages?: { id?: string }[] }>(alias, SERVICE, {
    url: '/messages',
    query: { q: `rfc822msgid:${messageId.replace(/^<|>$/g, '')}`, maxResults: 1 },
    touch: false,
  });
  const id = found.messages?.[0]?.id;
  return id && MESSAGE_ID_RE.test(id) ? id : undefined;
}

/**
 * The inbox the digest goes to: the chosen one, else the first linked account with Gmail whatever its state, so a
 * re-link needed there fails the run instead of moving the digest (other people's mail and tracked items) to another
 * person's inbox.
 */
export function digestInbox(accounts: Pick<AccountStore, 'list'>, s: Pick<DigestSettings, 'deliver_to'>): string | undefined {
  return s.deliver_to ?? accounts.list().find((a) => a.services.includes(SERVICE))?.alias;
}

/** Why the inbox cannot take the digest, in fixed words naming the alias only (it becomes the status); undefined when it can. */
export function inboxProblem(accounts: Pick<AccountStore, 'get'>, alias: string): string | undefined {
  const account = accounts.get(alias);
  if (!account) return `${alias} is no longer linked`;
  if (!account.services.includes(SERVICE)) return `${alias} has no Gmail`;
  if (account.status === 'needs_relink') return `${alias} needs to be re-linked on the admin page`;
  return undefined;
}

/**
 * Archives an earlier digest (its INBOX label removed; it stays in All Mail, read or not, starred or not). True when
 * done or when it is gone already; false, logged by error name, when it failed: the new digest is in the inbox
 * already, so nothing here is worth failing the run for.
 */
export async function archiveDigest(ctx: ToolContext, alias: string, messageId: string): Promise<boolean> {
  try {
    await ctx.google.request(alias, SERVICE, {
      method: 'POST',
      url: `/messages/${encodeId(messageId)}/modify`,
      body: { removeLabelIds: ['INBOX'] },
      idempotent: true,
      touch: false,
    });
    return true;
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return true;
    ctx.log.warn('followup digest: previous one not archived', { alias, error: err instanceof Error ? err.name : 'Error' });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduling

export type DigestOutcome =
  | { status: 'delivered'; alias: string; items: number }
  | { status: 'nothing' }
  /** detail: an AccountError's own message (it may name the address), for the owner's eyes now: never logged nor stored. */
  | { status: 'failed'; error: string; detail?: string }
  /** Another run is in progress. */
  | { status: 'busy' };

/** The wall-clock time in a zone, HH:MM. */
function localTime(timeZone: string, at: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** Minutes since midnight of an HH:MM time. */
function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** The day before a YYYY-MM-DD one. */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * The local day whose digest is due at `at`: today once its time has passed; yesterday during the CATCH_UP_MINUTES
 * after yesterday's time, when that ran past midnight (a time such as 23:58 can fall after the day's last tick).
 */
/** The ISO weekday of a YYYY-MM-DD. */
export function weekdayOf(day: string): Weekday {
  return WEEKDAYS[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7]!;
}

/** The day whose digest is due at `at` (see dueDay), when the settings' frequency has one on that day. */
export function scheduledDay(s: Pick<DigestSettings, 'time' | 'timezone' | 'frequency' | 'weekday'>, at: number): string | undefined {
  const day = dueDay(s.time, s.timezone, at);
  return day && (s.frequency === 'daily' || weekdayOf(day) === s.weekday) ? day : undefined;
}

export function dueDay(time: string, timeZone: string, at: number): string | undefined {
  const today = todayIn(timeZone, new Date(at));
  const now = minutesOf(localTime(timeZone, at));
  const due = minutesOf(time);
  if (now >= due) return today;
  return now + 24 * 60 - due <= CATCH_UP_MINUTES ? dayBefore(today) : undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class DigestScheduler {
  private running = false;

  constructor(
    readonly settings: DigestSettingsStore,
    private readonly makeCtx: () => ToolContext,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Runs the day's digest when it is due: enabled, the local time at or past the configured time (or just past
   * midnight after it, see dueDay), that day not yet done, and fewer than MAX_RETRIES retries spent on it.
   * Undefined when nothing was due.
   */
  async tick(): Promise<DigestOutcome | undefined> {
    if (this.running) return undefined;
    const s = this.settings.get();
    if (!s.enabled) return undefined;
    const day = scheduledDay(s, this.now());
    if (!day || (s.last_run_date !== undefined && s.last_run_date >= day)) return undefined;
    if (s.attempt_date === day && (s.attempts ?? 0) > MAX_RETRIES) return undefined;
    return this.run(s, day);
  }

  /**
   * The admin page's "Send now": whatever the time, the day or the switch, and delivered even when all is clear, so
   * the owner sees what it looks like. Before the scheduled time it is not that day's digest: the scheduled one still
   * comes, and a failure spends no retry. Once the time has passed on a day a digest is due, it is that day's digest
   * (fresher than the scheduled one would have been): no second one follows minutes later.
   */
  async runNow(): Promise<DigestOutcome> {
    if (this.running) return { status: 'busy' };
    const s = this.settings.get();
    const due = s.enabled ? scheduledDay(s, this.now()) : undefined;
    return this.run(s, undefined, due !== undefined && (s.last_run_date === undefined || s.last_run_date < due) ? due : undefined);
  }

  /** One run: scheduled for a local day, or Send now (no day; `settles` the due day it stands in for). */
  private async run(s: DigestSettings, day?: string, settles?: string): Promise<DigestOutcome> {
    this.running = true;
    const started = Date.now();
    const scheduled = day !== undefined;
    const failures = scheduled && s.attempt_date === day ? (s.attempts ?? 0) : 0;
    // A scheduled run that finished settles its day; Send now leaves the day and its retries alone, unless it stands in for it.
    const settled = scheduled ? { last_run_date: day, attempt_date: undefined, attempts: undefined } : settles ? { last_run_date: settles } : {};
    let accounts: AccountStore | undefined;
    let alias: string | undefined;
    try {
      const base = this.makeCtx();
      // "Today" (due, overdue) is the digest's day, in its zone.
      const ctx: ToolContext = { ...base, config: { ...base.config, defaultTimezone: s.timezone } };
      accounts = ctx.accounts;
      alias = digestInbox(ctx.accounts, s);
      if (!alias) throw new DigestError('no linked Gmail account');
      const problem = inboxProblem(ctx.accounts, alias);
      if (problem) throw new DigestError(problem);
      // Accounts unlinked since they were chosen are dropped; none left is not "all of them".
      const chosen = s.accounts.filter((a) => ctx.accounts.get(a));
      if (s.accounts.length && !chosen.length) throw new DigestError('the chosen accounts are no longer linked');

      const now = this.now();
      const report = await computeFollowups(ctx, {
        accounts: chosen.length ? chosen : undefined,
        now,
        max_threads_per_account: MAX_THREADS_READ,
        concurrency: DIGEST_CONCURRENCY,
        waiting_max_days: DIGEST_WAITING_MAX_DAYS,
        owed_max_days: DIGEST_WAITING_MAX_DAYS,
      });
      const items = digestItemCount(report);
      const failed = new Set((report.errors ?? []).map((e) => e.account));
      const unchecked = report.accounts.filter((a) => failed.has(a)).length;
      // Every account failing is more likely an outage than news: retry, and only the last try reports it.
      if (scheduled && unchecked && unchecked === report.accounts.length && failures < MAX_RETRIES) throw new DigestError('no account could be checked');
      // An earlier try may have put the day's digest in the inbox and failed after (a timeout once Gmail had it): that
      // copy is the day's digest, not a second one to insert.
      const messageId = scheduled ? digestMessageId(day, alias, ctx.config.baseUrl.hostname) : undefined;
      const earlier = messageId && failures ? await findDigest(ctx, alias, messageId) : undefined;
      if (scheduled && !items && !unchecked && !earlier) {
        // An email every day saying only that older mail was not read would be noise: the status says it.
        const cut = report.truncated?.length ?? 0;
        this.settings.record({ ...settled, last_status: cut ? 'nothing found in recent mail (older mail not read)' : 'nothing to report', last_run_at: this.now() });
        this.log.info('followup digest: nothing to report', { accounts: report.accounts.length, truncated: cut || undefined, ms: Date.now() - started });
        return { status: 'nothing' };
      }
      const inserted = earlier
        ? { id: earlier }
        : await deliverDigest(
            ctx,
            alias,
            renderDigest(report, { lang: s.lang, timezone: s.timezone, now, adminUrl: `${ctx.config.baseUrl.origin}/admin`, emailOf: (a) => ctx.accounts.get(a)?.email }),
            new Date(now),
            messageId,
          );
      const status = `delivered ${plural(items, 'item')}${unchecked ? `, ${plural(unchecked, 'account')} not checked` : ''}`;
      const latest = inserted.id && MESSAGE_ID_RE.test(inserted.id) ? { alias, message_id: inserted.id } : undefined;
      this.settings.record({ ...settled, last_status: status, last_run_at: this.now(), last_digest: latest });
      // The new digest replaces the previous one: at most one waits in the inbox.
      const previous = s.last_digest;
      const archived = previous && previous.message_id !== latest?.message_id ? await archiveDigest(ctx, previous.alias, previous.message_id) : undefined;
      this.log.info('followup digest delivered', { alias, items, unchecked, archived, found: earlier ? true : undefined, manual: !scheduled || undefined, ms: Date.now() - started });
      return { status: 'delivered', alias, items };
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      // An AccountError from Gmail itself (a credential refused just now): said in fixed words when the inbox now needs re-linking.
      const accountProblem = err instanceof AccountError && accounts && alias ? inboxProblem(accounts, alias) : undefined;
      const error = err instanceof DigestError ? err.message : (accountProblem ?? name);
      // Only scheduled runs spend the day's retries.
      this.settings.record({ last_status: `failed: ${error}`, last_run_at: this.now(), ...(scheduled ? { attempt_date: day, attempts: failures + 1 } : {}) });
      this.log.warn('followup digest failed', { error: name, attempt: scheduled ? failures + 1 : undefined, manual: !scheduled || undefined, ms: Date.now() - started });
      return { status: 'failed', error, ...(err instanceof AccountError && !accountProblem ? { detail: err.message } : {}) };
    } finally {
      this.running = false;
    }
  }
}
