/**
 * Builds an McpServer for one request: the endpoint is stateless in both
 * protocol eras (2025-era stateless streamable HTTP and the 2026-07-28
 * per-request envelope), so a fresh server per request is the simplest
 * correct model on a host that restarts.
 */
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { SERVICE_LABELS, SERVICES, type Service } from '../config.js';
import { AccountError, GoogleApiError } from '../google/client.js';
import { errorSummary } from '../log.js';
import { VERSION } from '../version.js';
import { compactJson, errorResult, fitResult, ToolInputError, type ToolContext, type ToolDefinition } from './registry.js';
import { gmailIdentity, mailbox } from './tools/gmail-identity.js';

export function serverInstructions(ctx: ToolContext): string {
  return [
    `${ctx.config.serverName}: one connector for several linked Google accounts (Gmail, Calendar, Sheets, Drive).`,
    'Every tool takes an `account` alias. Call list_accounts first if you are unsure which alias to use or what each account grants.',
    'Results are compact and paginated: use page tokens, `offset` and `max_chars` to read more.',
    `Default timezone: ${ctx.config.defaultTimezone}. Times are ISO 8601.`,
    'If a tool answers that an account needs re-linking, tell the user to open the admin page; do not retry.',
    "Files from this chat or the user's device cannot reach tools directly: create_upload_link gives a link the user opens to upload them at full size (or your sandbox POSTs to it), list_uploads then gives their upload_ids to use as attachments or Drive sources; upload_file (base64) only suits small files you made; letters and documents you write go into a Google Doc, whose PDF drive_doc_pdf makes in Drive.",
    "Mail goes out under the account's Gmail name with its Gmail signature (list_accounts shows both), so do not type the signature yourself; never leave blanks such as [phone] for the user to fill: ask for the detail instead. For one message to several separate recipients use gmail_create_drafts, then gmail_send_draft with draft_ids once the user has reviewed them.",
    'Sensitive contacts (bailiffs, lawyers, notaries, courts, administrations, insurers, property managers, the user\'s list in sensitive_contacts, people a follow-up waits on): the send tools save mail to them as a draft instead of sending it, with a risk review. Take the user through it before sending, even when they asked for a firm tone: what they depend on that person for, how the wording may be received (reproaches, irony, ultimatums, listing past failures), and length and frequency, since long or repeated emails make such people disengage. Offer a short, courteous version; send with gmail_send_draft reviewed_by_user: true only once the user confirmed the final text, never from a scheduled task.',
    'To send at a later time (tomorrow at 9:00), save the mail as a draft and call gmail_schedule_send: the connector sends it then by itself, no chat needed (for sensitive contacts, after the user approved the reviewed text). Do not tell the user to schedule it in Gmail themselves.',
    'Follow-ups: whenever the user waits on someone, or something must happen once a reply arrives, record it with followup_track (who, the next step, a due date; expects_attachment when a document is awaited). When asked what is pending, at the start of a working session or from a scheduled task, call followups and handle ready items first. The connector notifies no one by itself: outside a chat only the digest (followup_digest, daily or weekly, off by default) reminds the user, so do not promise a reminder without it.',
    "Files with the user's WhatsApp connector: to send a Drive file or attachment on WhatsApp, call whatsapp_create_upload_link, then send_to_link with its upload_url and the file, then whatsapp_send_file with the link_id; WhatsApp files come here through create_upload_link and whatsapp_files_to_link, then drive_save or attachments by upload_id.",
    'Documents the user uploads or receives that may be needed again (contracts, IDs, certificates): keep them with drive_save in the folder where similar documents are (drive_search shows folder paths; drive_search_all looks in every account), under a descriptive name.',
  ].join(' ');
}

/** A signature as list_accounts shows it: enough to recognise it and not retype it. */
const MAX_SIGNATURE_CHARS = 500;

export async function listAccountsResult(ctx: ToolContext): Promise<CallToolResult> {
  const accounts = await Promise.all(
    ctx.accounts.list().map(async (a) => {
      // Gmail's name and signature for the account (cached); none when Gmail is not granted or cannot be read.
      const identity = a.status === 'ok' && a.services.includes('gmail') ? await gmailIdentity(ctx, a.alias).catch(() => undefined) : undefined;
      return {
        alias: a.alias,
        email: a.email,
        label: a.label ?? undefined,
        services: a.services,
        status: a.status === 'ok' ? 'ok' : `needs_relink${a.statusDetail ? ` (${a.statusDetail})` : ''}`,
        gmail_name: identity?.displayName,
        gmail_signature: identity?.signature?.text.slice(0, MAX_SIGNATURE_CHARS),
        send_as: identity && identity.sendAs.length > 1 ? identity.sendAs.slice(1) : undefined,
        last_used: a.lastUsedAt ? new Date(a.lastUsedAt * 1000).toISOString() : undefined,
      };
    }),
  );
  if (accounts.length === 0) {
    return { content: [{ type: 'text', text: `No Google accounts are linked yet. Link one at ${ctx.config.baseUrl.href}admin` }] };
  }
  return { content: [{ type: 'text', text: compactJson({ accounts, admin_page: `${ctx.config.baseUrl.href}admin` }) }] };
}

/** Description for the `account` parameter listing the aliases that can serve this service right now. */
/**
 * Description of the `account` parameter. claude.ai caches the tool list for the
 * length of a conversation, so this is phrased as a snapshot and always points to
 * list_accounts: an account linked mid-conversation must not look unavailable.
 */
export function accountDescription(ctx: ToolContext, service: Service): string {
  const eligible = ctx.google.accountsFor(service).map((a) => `${a.alias} (${a.email})`);
  const broken = ctx.accounts
    .list()
    .filter((a) => a.status === 'needs_relink' && a.services.includes(service))
    .map((a) => a.alias);
  const snapshot = `Accounts with ${SERVICE_LABELS[service]} when this tool list was loaded: ${eligible.length ? eligible.join(', ') : 'none'}`;
  const relink = broken.length ? `; needing re-link: ${broken.join(', ')}` : '';
  return `Account alias. ${snapshot}${relink}. Call list_accounts for the current list.`;
}

/** An account named by its address ("me@gmail.com"), as Claude sometimes does, is the alias of the account linked with it. */
export function accountAlias(ctx: ToolContext, given: string): string {
  const wanted = given.trim().toLowerCase();
  if (!wanted.includes('@') || ctx.accounts.get(wanted)) return given;
  return ctx.accounts.list().find((a) => mailbox(a.email) === mailbox(wanted))?.alias ?? given;
}

/** Arguments with account (and accounts) given as addresses replaced by aliases. */
function withAliases(ctx: ToolContext, args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const a = args as { account?: unknown; accounts?: unknown };
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (typeof a.account === 'string') out['account'] = accountAlias(ctx, a.account);
  if (Array.isArray(a.accounts)) out['accounts'] = a.accounts.map((x) => (typeof x === 'string' ? accountAlias(ctx, x) : x));
  return out;
}

export async function runTool(def: ToolDefinition, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const started = Date.now();
  const args = withAliases(ctx, rawArgs);
  const given = typeof (args as { account?: unknown })?.account === 'string' ? (args as { account: string }).account : undefined;
  // Logs never carry an address: an unknown one is logged as such.
  const alias = given?.includes('@') ? 'unknown address' : given;
  try {
    const result = await def.handler(args as never, ctx);
    ctx.log.info('tool ok', { tool: def.name, alias, ms: Date.now() - started });
    return result;
  } catch (err) {
    if (err instanceof ToolInputError) {
      ctx.log.info('tool refused input', { tool: def.name, alias, ms: Date.now() - started });
      return errorResult(err.message);
    }
    if (err instanceof AccountError || err instanceof GoogleApiError) {
      ctx.log.info('tool failed', { tool: def.name, alias, ms: Date.now() - started, error: err.name });
      return errorResult(err.message);
    }
    if (err instanceof z.ZodError) {
      return errorResult(`Invalid arguments for ${def.name}: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    ctx.log.error('tool crashed', { tool: def.name, alias, ms: Date.now() - started, error: errorSummary(err) });
    return errorResult(`${def.name} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createMcpServer(ctx: ToolContext, tools: ToolDefinition[]): McpServer {
  const server = new McpServer(
    { name: 'g-spot-assistant', title: ctx.config.serverName, version: VERSION, websiteUrl: ctx.config.sourceUrl },
    { capabilities: { tools: {} }, instructions: serverInstructions(ctx) },
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List linked Google accounts',
      description: `Lists the linked Google accounts: alias, email, which services each grants (${SERVICES.join(', ')}) and whether it needs re-linking; for Gmail accounts also the name and signature mail goes out with (gmail_name, gmail_signature) and other send_as addresses. Call this first when unsure which account to use.`,
      inputSchema: z.object({}),
      // Reads each Gmail account's settings from Google (cached for 10 minutes).
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => listAccountsResult(ctx),
  );

  for (const def of tools) {
    const inputSchema: Record<string, z.core.$ZodType> = { ...def.inputSchema };
    if (def.service && inputSchema['account']) {
      inputSchema['account'] = (inputSchema['account'] as z.ZodString).describe(accountDescription(ctx, def.service));
    }
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: z.object(inputSchema),
        annotations: { openWorldHint: true, ...def.annotations },
      },
      // The SDK infers argument types from the schema; our handlers are typed per definition.
      (async (args: unknown) => fitResult(await runTool(def as ToolDefinition, args, ctx))) as never,
    );
  }
  return server;
}
