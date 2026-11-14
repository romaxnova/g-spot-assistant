/**
 * The account's own identity as Gmail's settings define it (users.settings.sendAs,
 * readable with gmail.modify): the display name for From, the signature Gmail's
 * composer adds, and the addresses the account sends as. Mail built through
 * the API gets neither name nor signature by itself, so recipients saw a bare
 * address and no signature; the send and draft tools now add both, as Gmail's
 * own composer does.
 *
 * Read once per account every 10 minutes (a changed signature shows up after
 * that), in the background: with a short timeout, no retry, and without
 * counting as a use of the account. A failure is not an error: the mail goes
 * out as before, from the bare address and without a signature.
 */
import type { ToolContext } from '../registry.js';
import { cleanText } from '../text.js';
import { formatAddress, htmlToText } from './gmail-mime.js';

const CACHE_MS = 10 * 60 * 1000;
/** The settings are optional: a slow answer must not hold up a send or list_accounts. */
const SETTINGS_TIMEOUT_MS = 5000;

interface SendAs {
  sendAsEmail?: string;
  displayName?: string;
  signature?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  /** False for an address the user only sends on behalf of (a group or shared mailbox): Gmail keeps it as a recipient. */
  treatAsAlias?: boolean;
  verificationStatus?: string;
}

export interface Signature {
  /** As Gmail stores it. */
  html: string;
  /** As plain text, for the text part and for recognising a signature already in the text. */
  text: string;
}

export interface GmailIdentity {
  email: string;
  /** Display name for From, when Gmail's settings give one. */
  displayName?: string;
  /** The account's own signature (its primary address); absent when none is set. */
  signature?: Signature;
  /** Signatures by send-as address (lower-case), for drafts written from an alias. */
  signatures: Map<string, Signature>;
  /** The addresses that are the account itself (lower-case, own address first): the primary and true aliases, as Gmail's reply-all sees them. */
  addresses: string[];
  /** Every address the account may send as (lower-case, own address first), including shared mailboxes. */
  sendAs: string[];
}

const cache = new WeakMap<object, Map<string, { at: number; identity: GmailIdentity }>>();

/** The account's identity. A failure to read Gmail's settings falls back to the bare address; only an unknown or unlinked account throws. */
export async function gmailIdentity(ctx: ToolContext, account: string): Promise<GmailIdentity> {
  const email = ctx.google.resolve(account, 'gmail').email;
  const perClient = cache.get(ctx.google) ?? new Map<string, { at: number; identity: GmailIdentity }>();
  cache.set(ctx.google, perClient);
  const key = `${account}\n${email.toLowerCase()}`;
  const hit = perClient.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.identity;
  let identity = identityFrom(email, []);
  try {
    const res = await ctx.google.request<{ sendAs?: SendAs[] }>(account, 'gmail', {
      url: '/settings/sendAs',
      timeoutMs: SETTINGS_TIMEOUT_MS,
      // One try: a retry would only delay the mail, which goes out without the settings anyway.
      idempotent: false,
      touch: false,
    });
    identity = identityFrom(email, res.sendAs ?? []);
  } catch (err) {
    ctx.log.info('gmail send-as settings unavailable', { alias: account, error: err instanceof Error ? err.name : 'unknown' });
    // A short-lived fallback, so a passing failure does not hide the name and signature for 10 minutes.
    perClient.set(key, { at: Date.now() - CACHE_MS + 60_000, identity });
    return identity;
  }
  perClient.set(key, { at: Date.now(), identity });
  return identity;
}

function signatureOf(entry: SendAs | undefined): Signature | undefined {
  const html = entry?.signature?.trim();
  const text = html ? cleanText(htmlToText(html)).trim() : '';
  return html && text ? { html, text } : undefined;
}

export function identityFrom(email: string, sendAs: SendAs[]): GmailIdentity {
  const own = email.toLowerCase();
  const usable = sendAs.filter((s) => s.sendAsEmail && (s.isPrimary || s.verificationStatus === undefined || s.verificationStatus === 'accepted'));
  const address = (s: SendAs) => s.sendAsEmail!.toLowerCase();
  const mine = usable.find((s) => address(s) === own) ?? usable.find((s) => s.isPrimary);
  const signatures = new Map<string, Signature>();
  for (const s of usable) {
    const sig = signatureOf(s);
    if (sig) signatures.set(address(s), sig);
  }
  const selves = usable.filter((s) => s.isPrimary || address(s) === own || s.treatAsAlias !== false).map(address);
  return {
    email,
    displayName: mine?.displayName?.replace(/[\r\n]+/g, ' ').trim() || undefined,
    signature: signatureOf(mine),
    signatures,
    addresses: [...new Set([own, ...selves])],
    sendAs: [...new Set([own, ...usable.map(address)])],
  };
}

/** The From header: "Name <address>" when Gmail's settings give a name (encoded as headers need), else the bare address. */
export function fromHeader(identity: GmailIdentity): string {
  return formatAddress(identity.displayName, identity.email);
}

/** The sender as people read it, for results: "François Élie <me@example.com>", never header-encoded. */
export function readableFrom(identity: GmailIdentity): string {
  const name = identity.displayName;
  if (!name) return identity.email;
  return `${/[",;<>@\\]/.test(name) ? JSON.stringify(name) : name} <${identity.email}>`;
}

/** The mailbox an address delivers to: lower-case, no +tag, and for Gmail no dots and googlemail.com as gmail.com. */
export function mailbox(address: string): string {
  const s = address.trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return s;
  let local = s.slice(0, at).replace(/\+.*$/, '');
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** Non-empty lines, whitespace collapsed, lower-case: how a signature is recognised whatever the spacing. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

/** Whether the text already carries the signature as whole lines, in order (a short signature such as "Tom" is not found inside "tomorrow"). */
export function containsSignature(text: string, signature: Signature): boolean {
  const body = lines(text);
  const sig = lines(signature.text);
  if (!sig.length) return false;
  for (let i = 0; i + sig.length <= body.length; i++) {
    if (sig.every((line, j) => body[i + j] === line)) return true;
  }
  return false;
}

/**
 * The body with a signature below it, the way Gmail's composer lays it out ("-- " then the signature; in HTML
 * inside a gmail_signature block so Gmail recognises it). The signature is the one of `from` (a send-as
 * address; default the account's own). Unchanged when that address has none, `wanted` is false, or the text
 * already carries any of the account's signatures. A blank HTML body counts as none, so no HTML part is made
 * that shows only the signature.
 */
export function withSignature(
  body: { text: string; html?: string },
  identity: GmailIdentity,
  wanted = true,
  from?: string,
): { text: string; html?: string; added: boolean } {
  const html = body.html?.trim() ? body.html : undefined;
  const signature = from === undefined || from.toLowerCase() === identity.email.toLowerCase() ? identity.signature : identity.signatures.get(from.toLowerCase());
  if (!wanted || !signature) return { text: body.text, html, added: false };
  const known = [...identity.signatures.values(), signature];
  const htmlText = html ? htmlToText(html) : '';
  if (known.some((sig) => containsSignature(body.text, sig) || (htmlText && containsSignature(htmlText, sig)))) return { text: body.text, html, added: false };
  return {
    text: `${body.text.replace(/\s+$/, '')}\n\n-- \n${signature.text}\n`,
    html: html && `${html}<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${signature.html}</div>`,
    added: true,
  };
}

/** Links that open a draft or a message in Gmail on the web, signed in as the right account. */
export function gmailWebUrl(email: string, kind: 'draft' | 'message' | 'thread', id: string): string {
  // The address picks the signed-in account (Gmail accepts it in place of the account number); "@" stays readable.
  const base = `https://mail.google.com/mail/u/${email.replace(/[^A-Za-z0-9@._+-]/g, (c) => encodeURIComponent(c))}/`;
  return kind === 'draft' ? `${base}#drafts?compose=${encodeURIComponent(id)}` : `${base}#all/${encodeURIComponent(id)}`;
}
