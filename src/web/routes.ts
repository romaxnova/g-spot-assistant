/**
 * Browser routes: the landing page (with the remaining setup steps on a fresh
 * install), owner sign-in, consent screen for Claude, and the admin page where
 * Google accounts are linked, re-linked and removed, and the follow-up digest
 * is set up.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { IDENTITY_SCOPES, SERVICES, SERVICE_LABELS, type Config, type Service } from '../config.js';
import { ALIAS_RE, isService, scopesForServices, servicesFromScopes, type AccountStore } from '../accounts.js';
import { INVITE_TTL, type AuthStore } from '../auth/store.js';
import type { ConnectorOAuthProvider } from '../auth/provider.js';
import type { ClientRegistry } from '../auth/clients.js';
import { attachSession, clearSessionCookie, requireSameOrigin, setSessionCookie } from '../auth/session.js';
import { decodeIdToken, type GoogleAuth } from '../google/oauth.js';
import type { GoogleClient } from '../google/client.js';
import { DIGEST_LANGS, digestInbox, DigestSettingsError, WEEKDAYS, type DigestScheduler, type DigestSettings } from '../followups/digest.js';
import type { Logger } from '../log.js';
import { errorSummary } from '../log.js';
import { esc, fmtTime, page } from './html.js';
import { memoryReport } from '../memory.js';

export interface WebDeps {
  config: Config;
  accounts: AccountStore;
  store: AuthStore;
  clients: ClientRegistry;
  provider: ConnectorOAuthProvider;
  googleAuth: GoogleAuth;
  googleClient: GoogleClient;
  log: Logger;
  digest: DigestScheduler;
}

const OWNER_LINK_TTL = 15 * 60;
/** "Every day at 08:00", "Every Monday at 09:00". */
function scheduleText(s: Pick<DigestSettings, 'frequency' | 'weekday' | 'time'>): string {
  return s.frequency === 'weekly' ? `Every ${s.weekday[0]!.toUpperCase()}${s.weekday.slice(1)} at ${s.time}` : `Every day at ${s.time}`;
}

const DIGEST_LANG_LABELS: Record<(typeof DIGEST_LANGS)[number], string> = { en: 'English', fr: 'Français' };
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Only relative paths on this site may be used as a post-login destination. */
export function safeNext(v: unknown): string {
  const s = str(v);
  return /^\/(?!\/)[\w\-./?=&%+]*$/.test(s) && s.length < 512 ? s : '/admin';
}

function servicesCheckboxes(checked: readonly Service[]): string {
  return SERVICES.map(
    (s) => `<label><input type="checkbox" name="services" value="${s}"${checked.includes(s) ? ' checked' : ''}> ${esc(SERVICE_LABELS[s])}</label>`,
  ).join('');
}

function contact(config: Config): string {
  return config.ownerEmails.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', ');
}

export function privacyPolicy(config: Config): string {
  return `<div class="card">
<p>${esc(config.serverName)} is a private, single-owner service. It connects the owner's Claude assistant to Google accounts that their owners have explicitly linked. It is not offered to the public.</p>
<h2>What is accessed</h2>
<p>For each linked Google account, only the services chosen when it was linked: Gmail, Google Calendar, Google Sheets and/or Google Drive, plus the account's email address to confirm who signed in. Data is read or changed only when the owner's Claude assistant asks for it.</p>
<h2>What is stored</h2>
<p>The linked account's email address, the list of granted services, and an encrypted Google refresh token. No email, calendar, spreadsheet or file content is stored, and none is written to logs.</p>
<h2>Where data goes</h2>
<p>Content fetched from Google is passed only to the owner's Claude assistant (Anthropic) to answer the owner's request. It is never sold, shared with anyone else, or used for advertising or model training by this service.</p>
<p>Use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Revoking access</h2>
<p>An account owner can revoke access at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. The service owner can also unlink an account, which deletes its stored token and revokes it at Google.</p>
<h2>Contact</h2>
<p>${contact(config)}</p></div>`;
}

/** What is left to do on a fresh install, with this server's own addresses filled in. */
export function setupSteps(config: Config): string {
  const origin = config.baseUrl.origin;
  const guide = config.sourceUrl.startsWith('https://github.com/') ? `${config.sourceUrl}/blob/main/docs/SETUP.md` : config.sourceUrl;
  return `<div class="alert warn">Almost there: Google sign-in is not set up yet.</div>
<div class="card"><h2>Finish the setup</h2><ol>
<li>In <a href="https://console.cloud.google.com/">Google Cloud</a>, create a project, enable the Gmail, Google Calendar, Google Sheets and Google Drive APIs, and set up the consent screen: audience <strong>External</strong>, then <strong>Publish app</strong> (in Testing, Google ends every link after 7 days). Its branding page asks for:
<br>home page <code>${esc(origin)}/</code> · privacy policy <code>${esc(origin)}/privacy</code> · terms <code>${esc(origin)}/terms</code> · authorized domain <code>${esc(config.baseUrl.hostname)}</code></li>
<li>Create an OAuth client of type <strong>Web application</strong> with this authorized redirect URI:<br><code>${esc(origin)}/auth/google/callback</code></li>
<li>Put its client ID and client secret in this server's environment variables <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> (on Railway: the service's <strong>Variables</strong> tab), and let the server restart.</li>
<li>Come back here, open the admin page and sign in with the owner's Google account (the one in <code>OWNER_EMAILS</code>), then link your Google accounts.</li>
<li>In Claude (Settings → Connectors → Add custom connector), paste <code>${esc(config.mcpUrl.href)}</code>.</li>
</ol><p class="muted">Every step in detail: the <a href="${esc(guide)}">setup guide</a>.</p></div>`;
}

export function termsOfService(config: Config): string {
  return `<div class="card">
<p>${esc(config.serverName)} is a private tool run by its owner for personal use. Only the owner and people who have agreed to link their own Google account use it.</p>
<p>By linking a Google account you allow the owner's Claude assistant to read and act on the services you granted, on the owner's instructions. You can revoke this at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
<p>The service is provided as is, without warranty. See the <a href="/privacy">privacy policy</a> for how data is handled.</p>
<p>Contact: ${contact(config)}</p></div>`;
}

export function createWebRouter(d: WebDeps): Router {
  const r = Router();
  const secure = d.config.baseUrl.protocol === 'https:';
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const adminUrl = `${d.config.baseUrl.origin}/admin`;

  r.use(attachSession(d.store));
  r.use(requireSameOrigin(d.config.baseUrl.origin));
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const fail = (res: Response, status: number, message: string, signedInAs?: string) =>
    res.status(status).send(page({ title: status >= 500 ? 'Something went wrong' : 'Cannot continue', body: `<div class="alert error">${esc(message)}</div><p><a href="/admin">Back to admin</a></p>`, signedInAs }));

  const GOOGLE_MISSING = 'Google sign-in is not set up yet: this server needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in its environment variables. The home page shows how to finish the setup.';
  const requireGoogle = (req: Request, res: Response, next: NextFunction) => {
    if (d.config.googleConfigured) return next();
    fail(res, 503, GOOGLE_MISSING, req.session?.email);
  };

  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (req.session) return next();
    if (req.method === 'GET') {
      res.redirect(302, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    fail(res, 403, 'Your session has expired. Sign in again.');
  };

  // ---- Public landing: until Google sign-in is set up, the steps that finish the setup ----
  r.get('/', (req, res) => {
    res.send(
      page({
        title: d.config.serverName,
        body: `${storageBanner()}${d.config.googleConfigured ? '' : setupSteps(d.config)}<p class="muted">Private remote MCP server. MCP endpoint: <code>${esc(d.config.mcpUrl.href)}</code></p><p><a class="btn" href="/admin">Open admin</a></p><p class="muted"><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a></p>`,
        signedInAs: req.session?.email,
      }),
    );
  });

  // ---- Public legal pages (linked from Google's OAuth consent screen) ----
  r.get('/privacy', (_req, res) => {
    res.send(page({ title: 'Privacy policy', body: privacyPolicy(d.config) }));
  });
  r.get('/terms', (_req, res) => {
    res.send(page({ title: 'Terms of service', body: termsOfService(d.config) }));
  });

  // ---- Owner sign-in (Google, allow-listed emails) ----
  r.get('/admin/login', limiter, (req, res) => {
    if (req.session) return res.redirect(302, safeNext(req.query['next']));
    const next = safeNext(req.query['next']);
    res.send(
      page({
        title: 'Sign in',
        body: `${googleBanner()}<div class="card"><p>Sign in with the <strong>owner's</strong> Google account (listed in <code>OWNER_EMAILS</code>).</p><p class="muted">Other Google accounts are not signed in here: the owner connects them afterwards with <strong>Link an account</strong> on the admin page.</p>
<form method="post" action="/admin/login/start"><input type="hidden" name="next" value="${esc(next)}"><button class="primary" type="submit">Sign in with Google</button></form></div>`,
      }),
    );
  });

  r.post('/admin/login/start', limiter, requireGoogle, form, (req, res) => {
    const next = safeNext(req.body?.next);
    const state = d.store.createGoogleState('login', { next });
    res.redirect(302, d.googleAuth.buildAuthUrl({ scopes: [...IDENTITY_SCOPES], state, offline: false }));
  });

  r.post('/admin/logout', (req, res) => {
    if (req.session) d.store.revokeSession(req.session.id);
    clearSessionCookie(res, secure);
    res.redirect(302, '/');
  });

  // ---- Google callback: finishes both the owner sign-in and the account-link flows ----
  r.get('/auth/google/callback', limiter, async (req, res) => {
    const stateParam = str(req.query['state']);
    const st = stateParam ? d.store.consumeGoogleState(stateParam) : undefined;
    if (!st) {
      d.log.warn('google callback refused', { reason: 'unknown_or_expired_state' });
      return fail(res, 400, 'This Google sign-in has expired or was already used. Start again.', req.session?.email);
    }
    const error = str(req.query['error']);
    const code = str(req.query['code']);
    if (error || !code) {
      d.log.warn('google callback refused', { purpose: st.purpose, reason: error || 'no_code' });
      return fail(res, 400, error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google returned an error (${error || 'no code'}).`, req.session?.email);
    }
    let tokens;
    try {
      tokens = await d.googleAuth.exchangeCode(code);
    } catch (err) {
      d.log.warn('google code exchange failed', { error: errorSummary(err) });
      return fail(res, 502, 'Could not complete the exchange with Google. Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the redirect URI, then try again.', req.session?.email);
    }
    let claims;
    try {
      if (!tokens.id_token) throw new Error('no id_token');
      claims = decodeIdToken(tokens.id_token, d.config.google.clientId);
    } catch (err) {
      d.log.warn('google id token invalid', { error: errorSummary(err) });
      return fail(res, 400, 'Google did not return a valid identity token.', req.session?.email);
    }
    const email = (claims.email ?? '').toLowerCase();
    if (!email || claims.email_verified === false) return fail(res, 400, 'Google did not return a verified email address.', req.session?.email);

    if (st.purpose === 'login') {
      if (!d.config.ownerEmails.includes(email)) {
        d.log.warn('owner sign-in refused: email not allow-listed');
        return fail(
          res,
          403,
          `${email} is not an owner of this server, so it cannot sign in here. To connect another Google account, sign in with the owner's account and use "Link an account" on the admin page.`,
        );
      }
      const id = d.store.createSession(email);
      setSessionCookie(res, id, secure);
      d.log.info('owner signed in');
      return res.redirect(302, safeNext(st.payload['next']));
    }

    // purpose === 'link'
    const linkToken = str(st.payload['linkToken']);
    const link = linkToken ? d.store.getLinkRequest(linkToken) : undefined;
    if (!link || link.usedAt) {
      d.log.warn('account link refused', { reason: 'link_request_expired_or_used' });
      return fail(res, 400, 'This link request has expired or was already used. Create a new one from the admin page.', req.session?.email);
    }
    if (!tokens.refresh_token) {
      d.log.warn('account link refused', { alias: link.alias, reason: 'no_refresh_token' });
      return fail(res, 400, 'Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions for that Google account, then try the link again.', req.session?.email);
    }
    if (link.expectedEmail && link.expectedEmail !== email) {
      d.log.warn('account link refused', { alias: link.alias, reason: 'unexpected_email' });
      await d.googleAuth.revoke(tokens.refresh_token);
      return fail(res, 400, `You signed in as ${email}, but this link is for ${link.expectedEmail}. Pick the right Google account and try again.`, req.session?.email);
    }
    const grantedScopes = (tokens.scope ?? '').split(' ').filter(Boolean);
    const granted = servicesFromScopes(grantedScopes);
    const missing = link.services.filter((s) => !granted.includes(s));
    d.accounts.upsertLinked({
      alias: link.alias,
      email,
      googleSub: claims.sub,
      label: link.label,
      refreshToken: tokens.refresh_token,
      grantedScopes,
      requestedServices: link.services,
    });
    d.store.markLinkRequestUsed(linkToken);
    d.googleClient.forget(link.alias);
    d.log.info('account linked', { alias: link.alias, services: granted.join(','), missing: missing.join(',') || null });
    const missingNote = missing.length
      ? `<div class="alert warn">Google did not grant: ${missing.map((s) => esc(SERVICE_LABELS[s])).join(', ')}. The consent screen lets you untick permissions; re-link and keep them all ticked if you need them.</div>`
      : '';
    res.send(
      page({
        title: 'Account linked',
        body: `<div class="alert">Linked <strong>${esc(link.alias)}</strong> (${esc(email)}) with: ${granted.map((s) => esc(SERVICE_LABELS[s])).join(', ') || 'no services'}.</div>${missingNote}<p>${
          req.session ? '<a href="/admin">Back to admin</a>' : 'You can close this window.'
        }</p>`,
        signedInAs: req.session?.email,
      }),
    );
  });

  // ---- Admin page ----
  r.get('/admin', requireOwner, (req, res) => {
    const accounts = d.accounts.list();
    const invites = d.store.listPendingLinkRequests().filter((l) => l.mode === 'invite');
    const families = d.store.listTokenFamilies();
    const msg = str(req.query['msg']);
    const hidden = (a: { requestedServices: Service[] }) => a.requestedServices.map((s) => `<input type="hidden" name="services" value="${s}">`).join('');
    const accountCards = accounts
      .map((a) => {
        const status = a.status === 'ok' ? '<span class="badge">ok</span>' : `<span class="badge warn">needs re-link</span>${a.statusDetail ? ` <span class="muted">${esc(a.statusDetail)}</span>` : ''}`;
        return `<div class="item">
<div class="item-head"><strong>${esc(a.alias)}</strong> ${status}</div>
<div class="muted">${esc(a.email)}${a.label ? ` · ${esc(a.label)}` : ''}</div>
<div>Grants: ${a.services.map((s) => esc(SERVICE_LABELS[s])).join(', ') || '<span class="muted">nothing</span>'}</div>
<div class="muted">Last used: ${fmtTime(a.lastUsedAt)}</div>
<div class="row">
<form class="inline" method="post" action="/admin/link"><input type="hidden" name="alias" value="${esc(a.alias)}"><input type="hidden" name="mode" value="now">${hidden(a)}<button type="submit">Re-link (I sign in)</button></form>
<form class="inline" method="post" action="/admin/link"><input type="hidden" name="alias" value="${esc(a.alias)}"><input type="hidden" name="mode" value="invite">${hidden(a)}<button type="submit">Re-link (invite owner)</button></form>
<form class="inline" method="post" action="/admin/unlink"><input type="hidden" name="alias" value="${esc(a.alias)}"><button class="danger" type="submit">Unlink…</button></form>
</div></div>`;
      })
      .join('');
    const inviteCards = invites
      .map(
        (l) => `<div class="item"><div class="item-head"><strong>${esc(l.alias)}</strong> <span class="muted">expires ${fmtTime(l.expiresAt)}</span></div>
<div>${l.services.map((s) => esc(SERVICE_LABELS[s])).join(', ')} · ${l.expectedEmail ? esc(l.expectedEmail) : 'any Google account'}</div>
<form class="inline" method="post" action="/admin/cancel-invite"><input type="hidden" name="alias" value="${esc(l.alias)}"><button type="submit">Cancel invite</button></form></div>`,
      )
      .join('');
    const familyCards = families
      .map(
        (f) => `<div class="item"><div class="item-head"><strong>${esc(f.subjectEmail)}</strong></div><div class="muted">Client: <code>${esc(f.clientId)}</code></div><div class="muted">Since ${fmtTime(f.createdAt)} · refresh valid until ${fmtTime(f.refreshExpiresAt)}</div></div>`,
      )
      .join('');
    res.send(
      page({
        title: `${d.config.serverName} — admin`,
        signedInAs: req.session!.email,
        body: `${storageBanner()}${msg ? `<div class="alert">${esc(msg)}</div>` : ''}
<p class="muted">MCP endpoint for claude.ai: <code>${esc(d.config.mcpUrl.href)}</code></p>
<h2>Linked accounts</h2>
<div class="card">${accounts.length ? accountCards : '<p class="muted">No accounts linked yet.</p>'}
<p class="muted">Re-linking keeps previously granted services (Google incremental authorization). To drop a service, unlink and link again.</p></div>
<h2>Link an account</h2>
<div class="card"><form method="post" action="/admin/link">
<label>Alias (short name Claude will use, e.g. <code>me</code>, <code>work</code>, <code>partner</code>)<br><input type="text" name="alias" required pattern="[a-z0-9][a-z0-9_-]{0,31}" placeholder="me"></label>
<label>Label (optional note)<br><input type="text" name="label" maxlength="80" placeholder="Personal account"></label>
<label>Expected Google email (optional; the link only accepts this account)<br><input type="email" name="expected_email" placeholder="someone@gmail.com"></label>
<p>Services to grant:</p>${servicesCheckboxes(['gmail'])}
<p>Who signs in?</p>
<label><input type="radio" name="mode" value="now" checked> I sign in to that Google account now</label>
<label><input type="radio" name="mode" value="invite"> Create an invite link (valid 7 days) for the account owner to open on their own device</label>
<p><button class="primary" type="submit">Continue</button></p></form></div>
${invites.length ? `<h2>Pending invite links</h2><div class="card">${inviteCards}</div>` : ''}
<h2>Follow-up digest</h2>
${digestCard()}
<h2>Claude connections</h2>
<div class="card">${families.length ? familyCards : '<p class="muted">No Claude client is connected yet. Add this server as a custom connector in claude.ai.</p>'}
<form method="post" action="/admin/revoke-claude"><p><button class="danger" type="submit">Disconnect all Claude sessions</button> <span class="muted">Claude will have to sign in again. Use this if a device is lost.</span></p></form></div>
<h2>Server</h2>
${serverCard()}`,
      }),
    );
  });

  // ---- Daily follow-up digest: settings, and "Send now" ----
  /** Linked accounts that grant Gmail (the digest reads and is delivered through Gmail). */
  const gmailAliases = () => d.accounts.list().filter((a) => a.services.includes('gmail')).map((a) => a.alias);

  function digestCard(): string {
    const s = d.digest.settings.get();
    const gmail = gmailAliases();
    const deliverTo = digestInbox(d.accounts, s);
    const relink = !!deliverTo && d.accounts.get(deliverTo)?.status === 'needs_relink';
    const badge = s.enabled ? '<span class="badge">on</span>' : '<span class="badge warn">off</span>';
    const reads = s.accounts.length ? s.accounts.map(esc).join(', ') : 'every linked Gmail account';
    const last = s.last_run_at ? `${fmtTime(Math.floor(s.last_run_at / 1000))}${s.last_status ? ` · ${esc(s.last_status)}` : ''}` : 'never';
    const checkboxes = gmail
      .map((a) => `<label><input type="checkbox" name="accounts" value="${esc(a)}"${s.accounts.includes(a) ? ' checked' : ''}> ${esc(a)}</label>`)
      .join('');
    const options = gmail.map((a) => `<option value="${esc(a)}"${a === deliverTo ? ' selected' : ''}>${esc(a)}</option>`).join('');
    const langs = DIGEST_LANGS.map((l) => `<option value="${l}"${l === s.lang ? ' selected' : ''}>${esc(DIGEST_LANG_LABELS[l])}</option>`).join('');
    const days = WEEKDAYS.map((w) => `<option value="${w}"${w === s.weekday ? ' selected' : ''}>${w[0]!.toUpperCase()}${w.slice(1)}</option>`).join('');
    const often = `<option value="daily"${s.frequency === 'daily' ? ' selected' : ''}>Every day</option><option value="weekly"${s.frequency === 'weekly' ? ' selected' : ''}>Once a week</option>`;
    return `<div class="card">
<div class="item-head">${badge} <span>${esc(scheduleText(s).replace(/ at \d\d:\d\d$/, ''))} at <strong>${esc(s.time)}</strong> (${esc(s.timezone)}), into the inbox of <strong>${esc(deliverTo ?? '—')}</strong></span></div>
<p class="muted">Reads ${reads}. Last run: ${last}.</p>
<p class="muted">A "Follow-ups" email put straight into the inbox (nothing is sent to anyone): items ready to act on, people waiting for a reply, unsent drafts, quote requests and mail still unanswered. No email when there is nothing to report; each new one archives the previous one.</p>
${gmail.length ? '' : '<div class="alert warn">Link an account with Gmail first: the digest is read from and delivered to Gmail.</div>'}${
      s.deliver_to && !gmail.includes(s.deliver_to) ? `<div class="alert warn"><strong>${esc(s.deliver_to)}</strong> is no longer linked with Gmail: choose another inbox below and save.</div>` : ''
    }${relink ? `<div class="alert warn"><strong>${esc(deliverTo)}</strong> needs to be re-linked: no digest is delivered until it is (re-link it above, or choose another inbox below).</div>` : ''}
<form method="post" action="/admin/digest">
<label><input type="checkbox" name="enabled" value="on"${s.enabled ? ' checked' : ''}> Send the digest</label>
<label>How often<br><select name="frequency">${often}</select></label>
<label>Day (once a week)<br><select name="weekday">${days}</select></label>
<label>Time<br><input type="time" name="time" value="${esc(s.time)}" required></label>
<label>Time zone<br><input type="text" name="timezone" value="${esc(s.timezone)}" placeholder="Europe/Paris" maxlength="64"></label>
<label>Language<br><select name="lang">${langs}</select></label>
${gmail.length ? `<p>Accounts to read (none ticked: all of them):</p>${checkboxes}<label>Deliver to<br><select name="deliver_to">${options}</select></label>` : ''}
<p><button class="primary" type="submit">Save digest settings</button></p></form>
<form method="post" action="/admin/digest/send"><p><button type="submit">Send now</button> <span class="muted">Puts a digest in the inbox now, even when all is clear, to see what it looks like; once the time has passed on a digest day, it stands in for that day's one.</span></p></form></div>`;
  }

  r.post('/admin/digest', requireOwner, form, (req, res) => {
    const gmail = new Set(gmailAliases());
    const raw = req.body?.accounts;
    const accounts = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const unknown = accounts.find((a) => !gmail.has(a));
    if (unknown !== undefined) return fail(res, 400, `"${unknown.slice(0, 40)}" is not a linked account with Gmail.`, req.session!.email);
    const deliverTo = str(req.body?.deliver_to).trim();
    if (deliverTo && !gmail.has(deliverTo)) return fail(res, 400, `"${deliverTo.slice(0, 40)}" is not a linked account with Gmail.`, req.session!.email);
    let saved;
    try {
      saved = d.digest.settings.update({
        enabled: str(req.body?.enabled) === 'on',
        frequency: str(req.body?.frequency) || undefined,
        weekday: str(req.body?.weekday) || undefined,
        time: str(req.body?.time),
        timezone: str(req.body?.timezone),
        lang: str(req.body?.lang),
        accounts,
        deliver_to: deliverTo || null,
      });
    } catch (err) {
      if (err instanceof DigestSettingsError) return fail(res, 400, err.message, req.session!.email);
      throw err;
    }
    d.log.info('followup digest settings saved', { enabled: saved.enabled, accounts: saved.accounts.length });
    const msg = saved.enabled ? `Digest on: ${scheduleText(saved).toLowerCase()} (${saved.timezone})` : 'Digest off';
    res.redirect(302, '/admin?msg=' + encodeURIComponent(msg));
  });

  r.post('/admin/digest/send', requireOwner, form, async (_req, res) => {
    const outcome = await d.digest.runNow();
    const msg =
      outcome.status === 'delivered'
        ? `Digest put in the ${outcome.alias} inbox (${outcome.items} item${outcome.items === 1 ? '' : 's'})`
        : outcome.status === 'busy'
          ? 'A digest is being prepared right now: try again in a minute.'
          : outcome.status === 'failed'
            ? `Digest not delivered (${outcome.error}). Check the linked accounts, then try again.`
            : 'Nothing to report';
    res.redirect(302, '/admin?msg=' + encodeURIComponent(msg));
  });

  // ---- Start a link (owner signs in now, or create an invite link) ----
  r.post('/admin/link', requireOwner, requireGoogle, form, (req, res) => {
    const alias = str(req.body?.alias).trim().toLowerCase();
    if (!ALIAS_RE.test(alias)) return fail(res, 400, 'Alias must be 1-32 characters: lowercase letters, digits, - or _.', req.session!.email);
    const raw = req.body?.services;
    const services = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter(isService);
    if (services.length === 0) return fail(res, 400, 'Pick at least one service.', req.session!.email);
    const mode = str(req.body?.mode) === 'invite' ? 'invite' : 'owner';
    const label = str(req.body?.label).trim().slice(0, 80) || null;
    const existing = d.accounts.get(alias);
    const expectedEmail = (str(req.body?.expected_email).trim().toLowerCase() || existing?.email || null)?.slice(0, 200) ?? null;
    const token = d.store.createLinkRequest(
      { alias, services, label, expectedEmail, mode, createdBy: req.session!.email },
      mode === 'invite' ? INVITE_TTL : OWNER_LINK_TTL,
    );
    if (mode === 'owner') return res.redirect(302, startGoogleLink(token, services, expectedEmail));
    const url = `${d.config.baseUrl.origin}/link/${token}`;
    res.send(
      page({
        title: 'Invite link created',
        signedInAs: req.session!.email,
        body: `<div class="card"><p>Send this link to the owner of the Google account. It works once and expires in 7 days.</p><pre>${esc(url)}</pre>
<p class="muted">They will see what is being requested (<strong>${esc(alias)}</strong>: ${services.map((s) => esc(SERVICE_LABELS[s])).join(', ')}) and sign in with Google.${
          expectedEmail ? ` Only <strong>${esc(expectedEmail)}</strong> is accepted.` : ''
        }</p><p><a href="/admin">Back to admin</a></p></div>`,
      }),
    );
  });

  function startGoogleLink(linkToken: string, services: Service[], loginHint: string | null): string {
    const state = d.store.createGoogleState('link', { linkToken });
    return d.googleAuth.buildAuthUrl({
      scopes: [...IDENTITY_SCOPES, ...scopesForServices(services)],
      state,
      offline: true,
      includeGrantedScopes: true,
      loginHint: loginHint ?? undefined,
    });
  }

  // ---- Invite link, opened by the account owner ----
  r.get('/link/:token', limiter, (req, res) => {
    const token = str(req.params['token']);
    const link = d.store.getLinkRequest(token);
    if (!link || link.usedAt) return fail(res, 404, 'This invite link is invalid, expired or already used.');
    res.send(
      page({
        title: 'Connect your Google account',
        body: `<div class="card"><p><strong>${esc(link.createdBy)}</strong> asks to connect your Google account to their Claude assistant under the name <strong>${esc(link.alias)}</strong>, with access to:</p>
<ul>${link.services.map((s) => `<li>${esc(SERVICE_LABELS[s])}</li>`).join('')}</ul>
${link.expectedEmail ? `<p>Sign in as <strong>${esc(link.expectedEmail)}</strong>.</p>` : ''}
<p class="muted">You sign in on Google's own page; this server never sees your password. It stores an encrypted access grant that you can revoke at any time at myaccount.google.com → Security → Third-party access.</p>
<form method="post" action="/link/${esc(token)}/start"><button class="primary" type="submit">Continue with Google</button></form></div>`,
      }),
    );
  });

  r.post('/link/:token/start', limiter, requireGoogle, form, (req, res) => {
    const token = str(req.params['token']);
    const link = d.store.getLinkRequest(token);
    if (!link || link.usedAt) return fail(res, 404, 'This invite link is invalid, expired or already used.');
    res.redirect(302, startGoogleLink(token, link.services, link.expectedEmail));
  });

  r.post('/admin/cancel-invite', requireOwner, form, (req, res) => {
    const alias = str(req.body?.alias);
    d.store.deleteLinkRequestsForAlias(alias);
    res.redirect(302, '/admin?msg=' + encodeURIComponent(`Cancelled pending links for ${alias}`));
  });

  // ---- Unlink (two-step confirmation, revokes the grant at Google) ----
  r.post('/admin/unlink', requireOwner, form, async (req, res) => {
    const alias = str(req.body?.alias);
    const account = d.accounts.get(alias);
    if (!account) return fail(res, 404, 'No such account.', req.session!.email);
    if (str(req.body?.confirm) !== 'yes') {
      return res.send(
        page({
          title: `Unlink ${alias}?`,
          signedInAs: req.session!.email,
          body: `<div class="card"><p>This removes <strong>${esc(alias)}</strong> (${esc(account.email)}) from the connector and revokes its grant at Google. Claude will no longer be able to use it.</p>
<form method="post" action="/admin/unlink"><input type="hidden" name="alias" value="${esc(alias)}"><input type="hidden" name="confirm" value="yes"><button class="danger" type="submit">Yes, unlink</button> <a class="btn" href="/admin">Cancel</a></form></div>`,
        }),
      );
    }
    try {
      await d.googleAuth.revoke(d.accounts.getRefreshToken(alias));
    } catch (err) {
      d.log.warn('could not revoke google token on unlink', { alias, error: errorSummary(err) });
    }
    d.accounts.remove(alias);
    d.googleClient.forget(alias);
    d.store.deleteLinkRequestsForAlias(alias);
    d.log.info('account unlinked', { alias });
    res.redirect(302, '/admin?msg=' + encodeURIComponent(`Unlinked ${alias}`));
  });

  r.post('/admin/revoke-claude', requireOwner, form, (req, res) => {
    const n = d.store.revokeAllTokens();
    d.log.info('all claude tokens revoked', { count: n });
    res.redirect(302, '/admin?msg=' + encodeURIComponent('All Claude sessions disconnected'));
  });

  // ---- Consent screen for the Claude → server OAuth flow ----
  r.get('/consent', limiter, requireOwner, async (req, res) => {
    const id = str(req.query['req']);
    const ar = id ? d.store.getAuthorizationRequest(id) : undefined;
    if (!ar) return fail(res, 400, 'This authorization request has expired. Go back to Claude and connect again.', req.session!.email);
    const client = await d.clients.getClient(ar.clientId);
    const redirect = new URL(ar.redirectUri);
    const loopback = LOOPBACK_HOSTS.has(redirect.hostname);
    res.send(
      page({
        title: 'Authorize Claude',
        signedInAs: req.session!.email,
        body: `<div class="card"><p><strong>${esc(client?.client_name ?? 'An OAuth client')}</strong> wants to use ${esc(d.config.serverName)} as <strong>${esc(req.session!.email)}</strong>.</p>
<p>After approval the browser is sent to <code>${esc(redirect.origin + redirect.pathname)}</code>.</p>
${loopback ? '<div class="alert warn">The redirect goes to a program on this computer (loopback address). Only approve if you just started this from Claude Code or another local MCP client.</div>' : ''}
<p class="muted">Client id: <code>${esc(ar.clientId)}</code></p>
<form method="post" action="/consent"><input type="hidden" name="req" value="${esc(ar.id)}">
<button class="primary" type="submit" name="decision" value="approve">Approve</button> <button type="submit" name="decision" value="deny">Deny</button></form></div>`,
      }),
    );
  });

  r.post('/consent', limiter, requireOwner, form, (req, res) => {
    const id = str(req.body?.req);
    const decision = str(req.body?.decision);
    const url = decision === 'approve' ? d.provider.approve(id, req.session!.email) : d.provider.deny(id);
    if (!url) return fail(res, 400, 'This authorization request has expired. Go back to Claude and connect again.', req.session!.email);
    res.redirect(302, url);
  });

  function googleBanner(): string {
    return d.config.googleConfigured ? '' : `<div class="alert warn">${esc(GOOGLE_MISSING)}</div>`;
  }

  /** Memory and uptime, for the owner: what the host bills is the container's figure. */
  function serverCard(): string {
    const m = memoryReport();
    const hours = Math.floor(process.uptime() / 3600);
    const up = hours >= 48 ? `${Math.floor(hours / 24)} days` : hours >= 1 ? `${hours} h` : `${Math.max(1, Math.round(process.uptime() / 60))} min`;
    const container = m.containerMb !== undefined ? `<div>Container: <strong>${m.containerMb} MB</strong> <span class="muted">(${m.containerAnonMb} MB process memory, ${m.containerFileMb} MB cached files)</span></div>` : '';
    return `<div class="card">${container}<div>Process: ${m.rssMb} MB resident, of which ${m.heapUsedMb} MB live objects</div><div class="muted">Running for ${up}. One line with these figures goes to the logs every hour.</div></div>`;
  }

  function storageBanner(): string {
    return d.config.storageWarning ? `<div class="alert error">${esc(d.config.storageWarning)}</div>` : '';
  }

  void adminUrl;
  return r;
}
