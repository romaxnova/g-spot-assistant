/**
 * Entry point: wires configuration, storage, Google and the HTTP app together.
 */
import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './log.js';
import { checkpoint, cleanupExpired, openDatabase } from './db.js';
import { AccountStore } from './accounts.js';
import { AuthStore } from './auth/store.js';
import { ClientRegistry } from './auth/clients.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { GoogleAuth } from './google/oauth.js';
import { GoogleClient } from './google/client.js';
import { createApp } from './app.js';
import { SqliteUploadVault, UploadStore } from './uploads.js';
import { FollowupStore } from './followups/store.js';
import { SensitiveContactsStore } from './contacts/sensitive-store.js';
import { ScheduledSendStore } from './mail/scheduled-store.js';
import { ScheduledSender } from './mcp/tools/gmail-schedule.js';
import { DigestScheduler, DigestSettingsStore } from './followups/digest.js';
import type { ToolContext } from './mcp/registry.js';
import { allTools } from './mcp/tools/index.js';
import { VERSION } from './version.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the daily digest checks whether it is due. */
const DIGEST_TICK_MS = 5 * 60 * 1000;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  const googleRedirectUri = `${config.baseUrl.origin}/auth/google/callback`;
  if (!config.googleConfigured) {
    log.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set: sign-in and account linking are disabled until they are; the home page shows the remaining setup steps', { home: `${config.baseUrl.origin}/`, googleRedirectUri });
  }
  if (config.storageWarning) log.warn(config.storageWarning);
  const db = openDatabase(config.dbPath);
  const accounts = new AccountStore(db, config.encryptionKey, config.encryptionKeyPrevious);
  if (config.encryptionKeyPrevious) {
    const n = accounts.reencryptWithCurrentKey();
    if (n > 0) log.info('re-encrypted refresh tokens with the current key; TOKEN_ENCRYPTION_KEY_PREVIOUS can be removed', { count: n });
  }
  const store = new AuthStore(db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: config.dcrEnabled }, log);
  const provider = new ConnectorOAuthProvider(
    store,
    clients,
    { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: config.accessTokenTtlSeconds, refreshTokenTtlSeconds: config.refreshTokenTtlSeconds },
    log,
  );
  const googleAuth = new GoogleAuth({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: googleRedirectUri });
  const googleClient = new GoogleClient(accounts, googleAuth, log, { adminUrl: `${config.baseUrl.origin}/admin` });

  // Files staged from the Claude chat survive deploys: encrypted in the database for 24 hours.
  const uploads = new UploadStore({}, Date.now, new SqliteUploadVault(db, [config.encryptionKey, config.encryptionKeyPrevious]));
  // Tracked follow-ups and dismissed threads, encrypted in the database like the staged files.
  const followups = new FollowupStore(db, [config.encryptionKey, config.encryptionKeyPrevious]);
  if (followups.unreadable > 0) {
    log.warn('no configured key opens some follow-ups: they are kept, unseen, until TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY_PREVIOUS opens them again', { count: followups.unreadable });
  }
  // The daily follow-up digest, put into an inbox at the time chosen on the admin page (off until enabled there).
  const sensitive = new SensitiveContactsStore(db, [config.encryptionKey, config.encryptionKeyPrevious]);
  if (sensitive.unreadable) log.warn('no configured key opens the list of sensitive contacts: it is kept, unseen, until TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY_PREVIOUS opens it again');
  const schedules = new ScheduledSendStore(db);
  const toolCtx: ToolContext = { config, accounts, google: googleClient, log, uploads, followups, sensitive, schedules };
  const digest = new DigestScheduler(new DigestSettingsStore(db, config.defaultTimezone), () => toolCtx, log);
  toolCtx.digest = digest;
  const app = createApp({ config, log, accounts, store, clients, provider, googleAuth, googleClient, tools: allTools, uploads, followups, sensitive, schedules, digest });
  // Express 5 calls this callback on failure too (e.g. port already in use), passing the error.
  const server = app.listen(config.port, '0.0.0.0', (err?: Error) => {
    if (err) {
      log.error('could not start listening', { port: config.port, error: err.message });
      process.exit(1);
    }
    log.info('listening', { version: VERSION, port: config.port, mcpUrl: config.mcpUrl.href, googleRedirectUri, tools: allTools.length + 1, accounts: accounts.list().length });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // Uploads from a phone on a slow connection can take minutes (Node's default cuts a request at 5).
  server.requestTimeout = 15 * 60_000;

  const housekeeping = setInterval(
    () => {
      try {
        const removed = cleanupExpired(db);
        const pruned = store.pruneClients(30 * 24 * 3600);
        // Closed follow-ups are kept 30 days; dismissals outlive the longest look-back (90 days) with room to spare.
        const forgotten = followups.purgeClosedBefore(Date.now() - 30 * DAY_MS) + followups.purgeDismissalsBefore(Date.now() - 180 * DAY_MS) + schedules.purgeBefore(Date.now() - 30 * DAY_MS);
        checkpoint(db);
        if (removed || pruned || forgotten) log.debug('housekeeping', { removed, pruned, followups: forgotten });
      } catch (err) {
        log.warn('housekeeping failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
    60 * 60 * 1000,
  );
  housekeeping.unref();

  // At most one digest a day: tick() does nothing until it is due (and records its own failures).
  const digestTimer = setInterval(() => {
    digest.tick().catch((err: unknown) => log.warn('followup digest tick failed', { error: err instanceof Error ? err.name : 'unknown' }));
  }, DIGEST_TICK_MS);
  digestTimer.unref();

  // Drafts scheduled with gmail_schedule_send go out within a minute of their time.
  const sender = new ScheduledSender(schedules, () => ({ ...toolCtx, digest }), log);
  const sendTimer = setInterval(() => {
    sender.tick().catch((err: unknown) => log.warn('scheduled sends tick failed', { error: err instanceof Error ? err.name : 'unknown' }));
  }, 60 * 1000);
  sendTimer.unref();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    clearInterval(housekeeping);
    clearInterval(digestTimer);
    clearInterval(sendTimer);
    server.close(() => {
      try {
        checkpoint(db, 'TRUNCATE');
      } catch {
        /* best effort */
      }
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
