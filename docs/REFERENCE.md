# Technical reference

Everything behind the [README](../README.md): the full list of tools, how the server is built, what it stores, every setting, and day-to-day operations. To install it, follow the [setup guide](SETUP.md).

## What Claude can do with it

Every tool takes an `account` alias (for example `me`, `work`, `partner`). `list_accounts` tells Claude which aliases exist and what each one grants; the `account` parameter description also lists the eligible aliases, so Claude never has to guess. Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so claude.ai's per-tool permissions work: set the sending, deleting and sharing tools to **Ask**.

| Service | Read (safe) | Write | Destructive |
|---|---|---|---|
| Accounts | `list_accounts` | | |
| Gmail | `gmail_search`, `gmail_get_message`, `gmail_get_thread`, `gmail_get_attachment` (text, PDF, Word, Excel, PowerPoint, images), `gmail_list_labels`, `gmail_awaiting_reply` (sent mail nobody answered), `gmail_find_contacts` (an address from a name) | `gmail_send`, `gmail_reply`, `gmail_create_draft` (all with attachments), `gmail_create_drafts` (mail merge: one personalised draft per recipient), `gmail_forward`, `gmail_send_draft` (one draft or a batch), `gmail_schedule_send` (send drafts at a later time), `gmail_modify_labels` (archive, read/unread, star, labels), `gmail_unsubscribe` (stop a newsletter: one-click, by email, or the link handed back) | `gmail_trash`, `gmail_cleanup` (bins thousands of old promotions or notifications after a preview the user confirms; starred, important, replied, receipt and sensitive mail left alone), `gmail_delete_draft`, `gmail_update_draft` (edits a draft in place: recipients, subject, text, attachments added or removed) |
| Calendar | `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_free_busy` | `calendar_create_event`, `calendar_update_event`, `calendar_respond` | `calendar_delete_event` |
| Sheets | `sheets_get_info`, `sheets_read` (one range, or up to 10 at once) | `sheets_write`, `sheets_append`, `sheets_create` | |
| Drive | `drive_search` (with each file's folder path), `drive_get_file` (Docs as Markdown, Sheets as CSV, Slides as text; PDF, Word, Excel, PowerPoint as text; images; scans by OCR) | `drive_save` (files from the chat or email into a folder path, duplicates skipped), `drive_doc_pdf` (update a Google Doc from Markdown/HTML and refresh its PDF in Drive), `drive_create_file` (text, bytes, or a copy of a Drive file or email attachment, from any linked account), `drive_update_file` (rename, move, replace content, restore), `drive_share` | `drive_trash` |
| Across accounts | `inbox_overview` (unread in every inbox), `agenda` (today across every calendar), `drive_search_all` (a document in every Drive) | | |
| Follow-ups | `followups` (what needs attention: tracked items, replies owed, unsent drafts, batches, unanswered mail) | `followup_track` (remember what the user waits for and what to do next), `followup_dismiss`, `followup_digest` (the daily or weekly reminder email) | |
| Files from the chat or the user's device | `list_uploads` | `create_upload_link` (a link the user opens to upload files at full size), `upload_file` (small files as base64) | `delete_uploads` |
| Other connectors of the owner (WhatsApp) | | `send_to_link` (push Drive files, attachments or uploads to another connector's upload link) | |

Outputs are deliberately compact: lists are paginated with page tokens, long bodies are clipped with `offset`/`max_chars` to read more, HTML mail is converted to text, invisible preheader padding and link tracking parameters (`utm_*` and similar) are removed, images embedded in an email body are counted rather than listed, CSV exports lose trailing empty cells, and empty fields are dropped.

### Files and attachments

**Reading.** `gmail_get_attachment` and `drive_get_file` return a file's content in the form Claude can use: text files as they are (in their declared charset; undeclared non-UTF-8 text is read as Windows-1252, or Windows-1251 when it looks Cyrillic, and the result says so); PDFs as their text layer, one `## Page N` section per page (first 100 pages, Chinese/Japanese/Korean fonts included, damaged pages marked and skipped); Word `.docx` as Markdown (headings, lists, tables); Excel `.xlsx` as CSV per sheet with ISO dates; PowerPoint `.pptx` as slide text with speaker notes (templates and slideshows too); PNG/JPEG/GIF/WebP images up to 96 KB as images Claude looks at (a tool result can carry no more). For Drive files that cannot be shown that way (large photos, HEIC, scanned PDFs) Claude gets Drive's own preview image. A scanned PDF or a photo of a document is read with `ocr: true` (both tools): Google's OCR converts it into a temporary Google Doc in the account's Drive, which is read and deleted at once. An old `.doc`/`.xls` comes with a hint: Google can convert it into a Google Doc/Sheet that is then readable.

**Conversions.** Converting into a Google file (OCR of a large scan, a long Word file) can take minutes, so those calls wait up to three minutes. When Google still has not answered, the connector looks for the file it was creating (each create carries a private tag, `appProperties`) and returns it, so a retry never leaves two copies; if it is not there yet, the error says not to create it again. An OCR read that runs out of time is picked up by the next call for the same file, from the Doc Google finished meanwhile.

**Documents Claude writes.** A letter is kept as a Google Doc (written in Markdown or HTML, which Drive converts). `drive_doc_pdf` updates the Doc and makes or refreshes its PDF in Drive from Google's own export, in one call: it replaces the PDF given, or the one of the same name in the folder, so the PDF keeps its id and links. No bytes pass through Claude's output; before, each revision of a 30 KB letter took ten `upload_file` chunks and ten minutes. Attach it with `gmail_update_draft` (`add_attachments [{drive_file_id}]`).

**Sending and saving.** `gmail_send`, `gmail_reply` and `gmail_create_draft` take `attachments`; `drive_create_file` and `drive_update_file` take `content_base64` or a `source`. A file is one of:

| Source | Example |
|---|---|
| A Drive file | `{"drive_file_id": "1AbC…"}`; Google Docs/Sheets/Slides are exported (PDF by default for email; `export_format` picks docx, xlsx, pptx, csv, md, …) |
| An attachment of another email | `{"gmail_message_id": "18f…", "gmail_part_id": "2"}` (part ids come from `gmail_get_message`) |
| A file from the chat (a PDF you uploaded, a file Claude made) | `{"upload_id": "up_…"}`, after staging it (see below) |
| A file Claude writes | `{"content": "name,qty\n…", "filename": "stock.csv"}` or `{"content_base64": "…", "filename": "chart.png"}` |

Add `"from_account": "<alias>"` to take the Drive file or email from another linked account, which is how files move between accounts (for example: save an attachment from one inbox into another account's Drive, or email a Drive file from a different account's address). A copy within one Drive happens inside Google (`files.copy`) and lands in My Drive's root unless `parent_folder_id` says otherwise; a Google Doc/Sheet/Slides copied into another account travels as docx/xlsx/pptx and is converted back into a Google file. Text files keep their charset when re-attached to an email and are re-encoded as UTF-8 on their way into Drive. `kind: "document" | "spreadsheet" | "presentation"` converts uploads (Word, RTF, HTML, Markdown, text, PDF and images by OCR into Docs; Excel, CSV and TSV into Sheets; PowerPoint into Slides).

**Files from the chat.** claude.ai does not pass the files of a conversation to connectors (MCP has no way to), and on Free/Pro/Max plans Claude's code sandbox may only reach Anthropic and package registries (npm, PyPI, GitHub…); only Team/Enterprise owners can allow more domains. A file therefore reaches the connector either through Claude's own output (base64, small files only) or because the user uploads it through a link. Files already in Gmail or Drive need neither. Staged files are then used by `upload_id`:

- `create_upload_link` returns a link valid for 30 minutes (up to 25 MB per file). **The user opens it** on their phone or computer: a plain page (no script) lets them upload files at full size, as many times as they like until it expires (on an iPhone, photos and documents come from different pickers), and lists what arrived. Claude then attaches everything that came through with `{"upload_id": "<link_id>"}`, or looks at the files with `list_uploads`. This works whatever the chat's sandbox may reach. Claude's code sandbox can also POST a file to the same link (`curl -F "file=@…" URL`) and gets the `upload_id` back, but only where the sandbox may reach this server: on Team/Enterprise plans an owner can add the domain (**Organization settings → Capabilities**, network egress to specific domains); on Free/Pro/Max plans it cannot.
- `upload_file` takes a file as base64 in tool calls, in chunks of about 15 KB, each checked by offset and SHA-256, the whole file verified at the end. Every byte passes through Claude's output, so it is slow and only suits small files Claude made itself; photos and PDFs go through the link, and letters Claude writes go into a Google Doc whose PDF `drive_doc_pdf` makes.

A staged file can be used any number of times (the same PDF in six drafts) for 24 hours after its last change. It is kept encrypted in the database (see *What is stored*), so a deploy in the middle of a task does not lose it. Upload links are stored there too, as hashes of their tokens only, so a link the user has open keeps working across a deploy. They are redacted from the connector's own logs (the host's edge or reverse-proxy logs may still record request paths, which is one reason links expire after 30 minutes). Photos a phone names meaninglessly (iOS's `4F9C2B1E-….jpeg`, `image.jpg`) are renamed `photo-1.jpeg`, `photo-2.jpeg`, … so recipients see a readable name; any other name is kept, and `filename` next to an `upload_id` renames a file for one attachment. Reloading the page shows what arrived instead of sending the files again; a second tap on Upload replaces the upload still in progress. Limits: 25 MB per file, 60 MB per upload, 50 files per link, 250 MB and 500 files staged in all; `delete_uploads` frees space early.

**Files with the owner's other connectors.** The WhatsApp connector issues upload links of the same kind. `send_to_link` resolves any file source (Drive file, email attachment, upload, written content; Google Docs as PDF unless `export_format` says otherwise) and POSTs it to such a link, up to 25 MB per file. The other connector then has it as an `upload_id`, e.g. for `whatsapp_send_file`. The other way, that connector POSTs files to this server's `create_upload_link`. Only hosts in `PEER_UPLOAD_HOSTS` are accepted, so a link that turns up in an email or a document cannot be used to send the owner's files elsewhere.

**Editing drafts.** `gmail_update_draft` changes only what it is asked to (recipients, subject, the text, attachments to add or remove) and keeps the rest of the draft byte for byte: formatting, images pasted into the text, other attachments, the thread and reply headers, the sender alias. It fetches the draft's raw message, edits the MIME tree in place (`src/mcp/tools/gmail-mime-edit.ts`) and saves it back with `drafts.update`. Gmail keeps no draft history, so the tool is marked destructive. `gmail_create_draft` with `draft_id` still rewrites a whole draft from its arguments. Adding one staged file to several drafts is one `gmail_update_draft` call per draft with the same `{"upload_id": …}`.

**Name and signature.** Mail built through the Gmail API gets neither the account's name nor its signature by itself, so recipients saw a bare address. The send and draft tools read Gmail's own settings (`users.settings.sendAs`, covered by `gmail.modify`): mail goes out as `Name <address>` with the signature Gmail's composer would add ("-- " then the signature; under the note and above the forwarded message for a forward). `signature: false` leaves it out, and text that already contains it (as whole lines) is not signed twice. A draft written from a send-as alias gets that alias's signature, or none. Mail sent with `body_text` only is plain text, so it carries the signature's text without its images or formatting; pass `body_html` too for the rich version. `list_accounts` shows each account's `gmail_name`, `gmail_signature` and other `send_as` addresses, which replies treat as the account itself. The settings are read once per account every 10 minutes; if they cannot be read, mail goes out as before. Change the name or signature in Gmail (**Settings → See all settings → General → Signature**, **Accounts → Send mail as**).

**Links.** Draft and send results carry `web_url`: a draft opens in Gmail's composer (to look it over on a phone before sending), a sent message in its thread, each in the right account.

**Several recipients, one message.** `gmail_create_drafts` is a mail merge: one template with `{{field}}` spots (`{{prénom}}`, `{{company}}`) and, per recipient, the addresses, the values and optionally files of their own; shared `attachments` go in every draft. Every field and address is checked before anything is created. The drafts carry the account's name and signature and a `web_url` each; once the user has looked them over, `gmail_send_draft` with `draft_ids` sends them together.

**Following up.** `gmail_awaiting_reply` lists sent mail nobody has answered: threads whose latest message is the account's own, sent between `days` and `min_days` ago (default 30 and 2), newest first, with how long each has waited. Aliases and `+tag` addresses count as the account, drafts are ignored, notes to self skipped, and auto-replies and bounces are no answer (a bounce is flagged: the address is probably wrong). `query` narrows it with Gmail search terms (`subject:devis`).

**Finding an address.** `gmail_find_contacts` finds someone's address from a name, a company or part of the address among the people the account has exchanged mail with (From/To/Cc/Bcc of recent messages that mention it), accents and case ignored, ranked by how often they appear. It uses Gmail only, so it needs no Google Contacts permission; drafts and no-reply senders are left out.

**Sensitive contacts.** Mail to people the user depends on is never sent straight away. These are bailiffs (commissaires de justice), lawyers, notaries, courts, administrations, insurers' claims services and property managers (recognised from the address), the user's own list (`sensitive_contacts`: addresses or whole domains, with a note), and anyone an open follow-up waits on. For them, `gmail_send`, `gmail_reply` and `gmail_forward` save the mail as a draft. The result carries a review for Claude to go through with the user:
- who they are and why they count;
- how many emails went to them in the last 7 and 14 days, and how many since their last answer (long or repeated emails make busy professionals and administrations disengage);
- the length of this one;
- wording that tends to read as a reproach or an ultimatum ("sans délai", "à plusieurs reprises", irony).

`gmail_send_draft` sends such a draft only with `reviewed_by_user: true`, which Claude may pass once the user saw that final text; a batch sends nothing until then. Judging tone stays Claude's job (the connector has no AI of its own and calls nothing but Google); the connector makes sure the pause cannot be skipped. A scheduled task can therefore only prepare drafts for these people.

**Sending later.** Gmail's API has no scheduled send, so the connector keeps its own: `gmail_schedule_send` takes drafts and a time ("tomorrow 09:00"), and a one-minute timer on the server sends them then, with no chat open.
- The checks of `gmail_send_draft` apply when scheduling and again at sending time. Unfilled blanks are refused. Sensitive contacts need the reviewed and approved version, with its review token.
- A draft to a sensitive contact that was edited after its approval is not sent.
- Nothing fails silently: a draft that is gone, edited after approval, still has blanks, was refused by Gmail, or could not be sent within 12 hours of its time leaves a "Not sent" notice in the account's inbox.
- A send is never retried after Gmail was asked, so nothing goes out twice.
- Scheduled drafts are left out of the follow-up lists. With no draft given, the tool lists what is scheduled; `cancel` takes schedule ids.

**Sending safely.** When a detail is missing, Claude tends to write a blank such as `[téléphone]`, `{{first_name}}` or `06 XX XX XX XX`. `gmail_send`, `gmail_reply`, `gmail_forward` (its note) and `gmail_send_draft` refuse a subject or text that still has one, name it, and send only after it is filled in or Claude passes `allow_placeholders: true` because the user confirmed it belongs there. Quoted replies and forwarded messages are not checked. `gmail_create_draft` and `gmail_update_draft` point blanks out as soon as they are written (the latter reads the saved draft back, so it also covers blanks the edit left alone). `gmail_send_draft` takes `draft_ids` to send a reviewed batch (up to 25) in one call: every draft is checked first, and if one is missing or has a blank, nothing is sent; otherwise they go one after the other and each result says whether it went.

Limits: 25 MB of attachments per email (Gmail's limit; larger mail is refused before anything is sent, with a suggestion to share a Drive link), 50 MB per file uploaded or copied through the connector (same-account Drive copies have no limit), 10 MB per Google export (Google's limit). Uploads above 5 MB use Drive's resumable protocol; mail above 4 MB goes through Gmail's upload endpoint.

### Follow-ups

Claude remembers nothing between chats and acts only when asked, so things slipped: a draft left unsent, quote requests nobody answered, replies owed, and chains such as "the lawyer sends the power of attorney, then it goes to the translators who quoted". The connector now keeps track:

- **`followups`** gives, in one call across the linked accounts:
  - **tracked**: items recorded with `followup_track`. An item is **ready** once mail from the awaited people arrives (looked for in every linked mailbox, so a reply sent to another linked account counts) or a new message lands in a watched thread. Otherwise it is overdue, due today, or still waiting. Two cases are only pointed out (`other_mail`), not taken as the answer: with watched threads, mail from the same people in another conversation (the council answering a different matter); and, for an item with `expects_attachment`, mail without a document (a signature's logo does not count). An arrival recorded under earlier rules is checked again against these. A ready item the user already wrote back on (to the sender, after the arrival) is marked `handled`: probably done, waiting to be closed.
  - **owed**: mail people sent that is still unanswered (and not answered another way: a mail to them since, in another thread or from another linked account), from people the account has written to (in the mail read, else by one Gmail search per sender), from the other linked accounts, or in a conversation the account took part in; `owed_from: "anyone"` adds first-time senders. Newsletters, notifications, mailing lists, no-reply senders (French `ne-pas-repondre`/`noreponse` and other languages too), one-time codes, security alerts, circulars to more than eight people, and mail between the linked accounts themselves (`include_internal` lists it) are left out.
  - **drafts**: drafts left unsent for more than 12 hours, saved within the look-back (30 days by default). One in a thread where a reply went out since is marked `superseded` (a leftover).
  - **batches**: one request sent separately to three or more people, with who replied (whether the user wrote back, whether the reply is still unread) and who never did. Once the user has answered someone, that thread also waits under **waiting** like any sent mail.
  - **waiting**: sent mail nobody answered, newest first; a request every recipient answered another way (in another thread, or to another linked account) is left out. Forwards nobody answered are taken as FYI and left out (`include_forwards` lists them); `waiting_max_days` drops older ones, and the digest shows three weeks at most.

  What a ready item awaited, and its threads up to that arrival, are listed under the item only, and stay off the lists once the item is closed; anything newer in them is listed again. Each row links to Gmail. `followup_dismiss` hides a thread (by `thread_id`) from every list until something new arrives in it, or until a date. Given a draft's `draft_id`, it hides only that draft, until it is edited: the thread's owed, waiting and batch rows stay.

  Each list reads its own age window (sent mail old enough to wait on, mail received more than 12 hours ago), at most 40 threads per list and account, newest activity first (`max_threads_per_account`, up to 100), and at least the 50 most recent drafts. The digest reads 100 threads per list, three requests at a time per mailbox. When an account has more, `truncated` names it. `followups` then says how much was read instead of reporting that nothing is pending, and the digest says only that account's recent mail was read. On a day when nothing was found in that mail, no digest is sent and the last status reads "nothing found in recent mail (older mail not read)". An account that needs re-linking is reported as not checked, never skipped.
- **`followup_track`** records who is awaited, the next step once they reply, and a due date. Items are kept encrypted in the database and closed with `status: "done"`. The connector cannot remind anyone by itself: outside a chat, only the digest (daily or weekly) does, so it is worth turning on.
- **Digest.** Every day or once a week (frequency, weekday), at the chosen time, the connector puts a "Follow-ups" email into the chosen inbox, with the same sections and a link for every line. It works without Claude: nothing is sent, the email is inserted with Gmail's `messages.insert`. Turn it on and set the time, language, accounts and inbox from the chat (`followup_digest`) or on the admin page; **Send now** shows what it looks like.
  - **Inbox:** only an account with Gmail. If none is chosen, the digest goes to the first linked account with Gmail, and that choice is saved when the digest is turned on from the chat. If that inbox needs re-linking, no digest goes out until it is fixed, rather than going to someone else's inbox. The last status on the admin page and in `followup_digest` says why.
  - **Accounts not read:** accounts that could not be read, including those that need re-linking, are listed first, under **Not checked**.
  - **Retries:** a failed run is retried up to three times that day. Each try first looks for a copy an earlier try may have left in the inbox (by its Message-ID). A try that timed out after Gmail stored the digest therefore does not bring a second copy.
  - **Size:** each new digest archives the previous one. A very full digest is cut at about 90 KB, with the rest counted, so Gmail does not clip it.
- **Claude's scheduled tasks** can call `followups` each morning and draft what is due ("go through my follow-ups").

### Keeping documents

`drive_save` puts files uploaded in the chat (`upload_id`, or a `link_id` for everything sent through one upload link), email attachments, or another account's Drive files into a folder of the right person's Drive:
- **Folder:** given by id or URL, or by a path such as `Appartements/Lisbonne/Contrats` (or as `drive_search` shows it, also for a folder whose name holds a `/`). Missing folders are created. A path that starts with `…/` is incomplete (a folder outside My Drive, such as a computer backed up by Drive for desktop or a folder shared on its own): such a folder is given by id.
- **Name and description:** a descriptive name and an optional description, which Drive search covers.
- **Duplicates:** files already in the folder with the same content are skipped.

Drive searches the text inside images and PDFs, so a saved scan is found the next time it is needed. `drive_search` shows each file's folder path, so Claude can put a document next to similar ones, and `drive_search_all` searches every linked Drive at once.

## Architecture

```
 Claude (claude.ai / mobile / desktop / Claude Code)
   │  OAuth 2.1 + PKCE (Claude is the client; this server is the authorization server)
   │  Streamable HTTP MCP, Bearer token
   ▼
 This server (Node 22+, Express 5, MCP TypeScript SDK) on Railway, Docker or any Node host
   ├─ /.well-known/*  /authorize  /token  /register  /revoke   ← OAuth for Claude
   ├─ /mcp                                                     ← tools, bearer-protected, MCP 2026-07-28 and 2025 revisions
   ├─ /admin  /consent  /link/<invite>  /auth/google/callback   ← browser pages for the owner
   └─ SQLite on a volume (/data/connector.sqlite)
   │  Google OAuth 2.0 (this server is the client; one refresh token per linked account)
   ▼
 Google APIs (gmail, calendar, sheets, drive)  — the only outbound destination
```

### Two authentication layers

**A. Claude → this server.** Claude connects like it would to any OAuth-protected MCP server:

1. The MCP endpoint answers `401` with `WWW-Authenticate: Bearer resource_metadata=…`. Claude reads the protected-resource metadata (`resource` is exactly the MCP URL) and the authorization-server metadata (`code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `"none"` in `token_endpoint_auth_methods_supported`).
2. Claude identifies itself with a **Client ID Metadata Document** (a URL on `claude.ai`). The server fetches and validates that document; only hosts in `CIMD_ALLOWED_HOSTS` are accepted, and every redirect URI in it must be on the allow-list (Claude's callback on `claude.ai` and `claude.com`, ChatGPT's callbacks, and the loopback URLs Claude Code uses). Dynamic client registration (which ChatGPT uses) is available too, with the same redirect allow-list.
3. `/authorize` stores the request and sends the browser to the **consent page**. The owner signs in with Google; only emails in `OWNER_EMAILS` are accepted. The page shows the client name and where the browser will be redirected, then the owner approves.
4. A one-time authorization code goes back to Claude; `/token` verifies PKCE and issues an opaque access token (1 h) and refresh token (90 days). Refresh tokens **rotate** on every use; presenting a rotated one again revokes the whole token family (leak detection). Dead tokens answer `invalid_grant`, as Claude expects.
5. Every MCP request is checked against the token store. Tokens are random and stored as SHA-256 hashes.

**B. This server → Google.** Each linked account is a Google OAuth grant obtained with `access_type=offline&prompt=consent` so a refresh token is returned. Scopes are chosen per account on the link form and kept minimal (`gmail.modify`, `calendar`, `spreadsheets`, `drive`, plus `openid email` to confirm who signed in). Refresh tokens are encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`) before they touch the database. Access tokens live only in memory. When Google answers `invalid_grant` (password changed, access revoked, consent screen left in Testing mode), the account is flagged **needs re-link** and every tool answers with a sentence saying exactly that.

### Linking accounts

The admin page (`/admin`, owner sign-in required) links an alias to a Google account in one of two ways:

- **I sign in now**: the owner completes Google's consent screen in the same browser.
- **Invite link**: a single-use link (7 days) that the account's owner opens on their own device. The page says who is asking, which alias and which services; the invitee signs in on Google's page. Optionally the link only accepts one expected email.

Re-linking uses Google's incremental authorization, so previously granted services survive. Unlinking revokes the grant at Google and deletes the row.

### What is stored

| Table | Contents | Lifetime |
|---|---|---|
| `accounts` | alias, email, encrypted refresh token, granted scopes, status | until unlinked |
| `tokens` | SHA-256 hashes of Claude's access/refresh tokens, expiry, token family (one per Claude connection) | until expiry + 1 day |
| `authorization_requests`, `authorization_codes`, `google_states` | in-flight OAuth handshakes | minutes |
| `sessions` | owner browser sessions (hashed ids) | 12 hours |
| `link_requests` | pending invite links (hashed) | 15 minutes / 7 days |
| `oauth_clients` | dynamically registered clients (fallback path) | pruned after 30 days unused |
| `staged_files` | files staged from the Claude chat: name, type and bytes encrypted (AES-256-GCM, key derived from `TOKEN_ENCRYPTION_KEY`) | 24 hours after the last change |
| `upload_links` | open upload links: SHA-256 hash of the token, expiry, the optional file name encrypted | 30 minutes |
| `followups` | tracked follow-ups: title, next step, notes, awaited addresses, watched threads, whether a document is awaited, and the sender and subject of the message that arrived, encrypted (AES-256-GCM); account, status and due date in clear | until closed, then 30 days |
| `followup_dismissals` | threads hidden from the follow-up lists (account, thread id, dates, whether only the draft is hidden) | until the thread's latest message and the dismissal are both 180 days old (a dismissal hiding a draft is renewed while the draft exists) |
| `scheduled_sends` | drafts to send later: account, draft and message ids, time, status (no mail content) | 30 days after sending |
| `followup_digest_settings` | the digest's settings and last run | while used |

No email, event or sheet content is ever stored (apart from the sender and subject of a tracked item's awaited message, encrypted), and no content at all is logged; the only files kept are the ones staged from the chat, encrypted and for a day. Logs contain method, path, status, duration, tool name, alias and MCP method names and protocol version only.

## Security notes

- The hosting account is the root of trust: whoever can read the server's variables (the Railway project, the server's `.env`) can decrypt the refresh tokens. Keep it behind 2FA.
- An attacker holding only the SQLite file gets AES-GCM ciphertext and token hashes.
- Anyone can reach the public URL, but every MCP call needs a bearer token that only exists after an allow-listed owner approved a consent screen. Redirect URIs are pinned, PKCE is mandatory, the `resource` parameter must name this server, and state parameters are single-use.
- Browser POSTs require a same-origin `Origin` header (CSRF), cookies are `HttpOnly; Secure; SameSite=Lax`, responses carry HSTS, a strict CSP and `X-Frame-Options: DENY`.
- Rate limits: OAuth endpoints (SDK defaults), browser flows (60 / 15 min per IP), MCP endpoint (300 / min per IP).
- Optional: `ANTHROPIC_IP_LOCK=true` restricts the MCP endpoint to Anthropic's egress range `160.79.104.0/21` (this blocks Claude Code, which calls from your machine).
- Google Cloud project: keep the consent screen **published**; in Testing mode refresh tokens expire after 7 days. The app stays unverified, which is fine under 100 users; owners click through the warning once.
- Files from mail and Drive are untrusted input. PDFs are parsed in a separate worker thread that is stopped when the process grows by more than 768 MB or after 30 s (a PDF of a few kilobytes can be built to expand to gigabytes); Word/Excel/PowerPoint files go through a ZIP reader with per-entry and per-archive size limits. MIME types and file names given by Claude or by senders are validated before they reach any MIME or upload header, and the Google token is only ever sent to Google's API hosts, the Drive upload session URL Google returns, and Drive's thumbnail host.

## Configuration

All configuration is environment variables. Nothing secret lives in the repository. [.env.example](../.env.example) lists them all.

| Variable | Required | Meaning |
|---|---|---|
| `OWNER_EMAILS` | yes | Comma-separated Google emails allowed to sign in and connect Claude |
| `TOKEN_ENCRYPTION_KEY` | yes | 32 bytes (base64 or hex) encrypting tokens and stored data at rest: `npm run generate-secrets` or `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes* | Google Cloud OAuth "Web application" client. *The server starts without them and its home page shows the remaining setup steps. |
| `BASE_URL` | yes* | Public origin, e.g. `https://assistant.example.com`. *Found by itself on Railway (`RAILWAY_PUBLIC_DOMAIN`) and Render (`RENDER_EXTERNAL_URL`). |
| `DEFAULT_TIMEZONE` | | IANA zone for times given without one, the agenda and the digest (default `UTC`) |
| `PORT` | | Listening port (default 8080) |
| `DATA_DIR` / `DB_PATH` | | Where the SQLite file lives (default: the Railway volume's mount path, else `/data`) / its exact path |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | | Old key during rotation (see below) |
| `MCP_PATH` | | Default `/mcp` |
| `SERVER_NAME` | | Shown in metadata and pages (default `G-Spot Assistant`) |
| `SOURCE_URL` | | Where the source is published, linked from every page (default this repository; a modified copy should point to its own, as the AGPL asks) |
| `PEER_UPLOAD_HOSTS` | | Host names of your other connectors (e.g. the WhatsApp connector, `wa-production.up.railway.app`) that `send_to_link` may push files to; empty refuses every push |
| `CIMD_ALLOWED_HOSTS` | | Hosts whose client metadata documents are accepted (default `claude.ai`) |
| `EXTRA_REDIRECT_URIS` | | Extra allowed OAuth redirect URIs, e.g. MCP Inspector's `http://localhost:6274/oauth/callback`; an entry ending in `/*` accepts any one last path segment |
| `DCR_ENABLED` | | Dynamic client registration (default `true`; ChatGPT needs it) |
| `ANTHROPIC_IP_LOCK`, `ANTHROPIC_IP_RANGES` | | Restrict `/mcp` to Anthropic's IPs (default off, `160.79.104.0/21`) |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS` | | Defaults 3600 and 90 |
| `TRUST_PROXY` | | Proxy hops in front of the app (default `1`, as on Railway or behind one reverse proxy) |
| `LOG_LEVEL` | | `debug`, `info`, `warn`, `error` |

## Operations

**Add an account.** Admin page → *Link an account*. Pick the alias, the services, and either sign in yourself or create an invite link. See [docs/SETUP.md](SETUP.md).

**Remove an account.** Admin page → *Unlink…* → confirm. The grant is revoked at Google. The account owner can also revoke it at <https://myaccount.google.com/permissions>.

**Re-link a broken account.** The admin page shows *needs re-link* with the reason; click *Re-link*. Claude's tools say the same thing when they hit a dead grant.

**Disconnect Claude.** Admin page → *Disconnect all Claude sessions* revokes every token; reconnect from claude.ai. Removing the connector in claude.ai also works (its tokens then expire unused).

**Rotate the encryption key.**
1. Generate a new key: `npm run generate-secrets`.
2. In the server's variables set `TOKEN_ENCRYPTION_KEY_PREVIOUS` to the *current* key and `TOKEN_ENCRYPTION_KEY` to the new one. Restart.
3. At startup the server re-encrypts every row and logs `re-encrypted refresh tokens with the current key`. Remove `TOKEN_ENCRYPTION_KEY_PREVIOUS`.

Tracked follow-ups need the previous key too. If a deploy goes out without it (or with a mistyped key), they are not lost: the log warns how many no key opens, and they come back once the right variable is set again.

**Rotate the Google client secret.** Google Cloud → the OAuth client → *Add secret*, put the new value in `GOOGLE_CLIENT_SECRET`, then disable the old secret. Existing refresh tokens keep working (they are bound to the client id, not the secret). Creating a *new* OAuth client instead would require re-linking every account.

**Updates.** On Railway, redeploy from the latest version of the repository (a service deployed from your own fork updates when you sync the fork). With Docker: `git pull && docker compose up -d --build`. The database upgrades itself at start.

**Backups.** The only state is `/data/connector.sqlite` (plus its `-wal`/`-shm` companions while the server runs; the log is folded into the main file and emptied hourly and at shutdown, and the space of deleted rows, such as cleared uploads, is given back to the disk hourly). It is useless without `TOKEN_ENCRYPTION_KEY`, so keep the key somewhere safe too. Losing the file costs nothing but re-linking the accounts, reconnecting Claude and the follow-ups recorded.

**Logs.** Railway → service → Logs, or `docker compose logs`. JSON lines, metadata only.

**Memory.** The server settles at about 150 to 200 MB. Two settings of the Docker image keep it there: Node starts with a 2 MB young generation (`--max-semi-space-size=2`; by default Node 24 lets it grow to 32 MB under a burst of requests and keeps it), and glibc hands blocks over 128 KB back to the system once freed (`MALLOC_MMAP_THRESHOLD_`, `MALLOC_TRIM_THRESHOLD_`, `MALLOC_ARENA_MAX=2`; by default it keeps them after each larger attachment, upload or PDF than before, so memory climbs in steps and never comes down). Without them the same traffic holds 320 to 400 MB. Run outside the image, set them yourself. Once an hour the log has a `memory` line: the process's resident memory (`rssMb`), the live JavaScript heap (`heapUsedMb`), the container's memory as the host counts it (`containerMb`, split into the process's own `containerAnonMb` and cached file pages `containerFileMb`, when the system exposes them) and the database's size (`dbMb`, of which `dbFreeMb` is unused). The admin page shows the same figures under *Server*. A heap that keeps growing from one line to the next is a leak; resident memory that rises after a large file and then stays flat is the allocator keeping memory for reuse. `npm run soak` drives the real app with a fake Google for a thousand rounds of the calls Claude makes and prints the same figures; `SOAK_MAX_GROWTH_MB=10 npm run soak` fails when the heap grows more than that.

## Development

```bash
npm ci
cp .env.example .env            # BASE_URL=http://localhost:8080, DATA_DIR=./data, the Google client, your email, a key
npm run dev                     # builds and starts with .env
npm test                        # builds, then runs the node:test suites (no network needed)
npm run typecheck
docker compose up --build       # the same image Railway builds
```

CI (`.github/workflows/ci.yml`) type-checks, tests and builds the Docker image on every push and pull request. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the rules every change keeps (nothing but Google on the network, no content in logs, no real people in tests).

For a Google client used locally add `http://localhost:8080/auth/google/callback` as a second redirect URI. To poke at the MCP endpoint with MCP Inspector, set `EXTRA_REDIRECT_URIS=http://localhost:6274/oauth/callback`.

Layout:

```
src/config.ts            environment → typed config
src/db.ts                SQLite schema (node:sqlite, no native module)
src/crypto.ts            AES-256-GCM, hashing, random tokens
src/accounts.ts          linked accounts, encrypted refresh tokens, key rotation
src/google/oauth.ts      Google OAuth: auth URL, code exchange, refresh, revoke, id_token decoding
src/google/client.ts     Google REST client with account routing and error mapping
src/auth/store.ts        codes, tokens, sessions, link requests, states (hashed)
src/auth/clients.ts      CIMD fetching/validation + dynamic client registration
src/auth/provider.ts     OAuthServerProvider for the MCP SDK (PKCE via the SDK, rotation, resource binding)
src/auth/session.ts      cookie + CSRF helpers
src/web/routes.ts        landing, sign-in, admin, link, invite, consent pages
src/mcp/registry.ts      tool contract and compact-output helpers
src/mcp/server.ts        McpServer per request, list_accounts, dynamic alias descriptions
src/mcp/tools/*.ts       gmail, calendar, sheets, drive, cross-account tools
src/mcp/tools/file-sources.ts  attachments and copies: Drive file, Gmail attachment, text or base64 → bytes
src/mcp/tools/gmail-identity.ts  the account's Gmail name, signature and send-as addresses; web links
src/mcp/tools/gmail-merge.ts, gmail-followup.ts, gmail-contacts.ts  mail merge, awaiting reply, find contacts
src/mcp/tools/placeholders.ts  blanks such as [téléphone] that must not be sent
src/mcp/extract/*.ts     file content for Claude: PDF (pdf.js), Word/Excel/PowerPoint (own ZIP + XML reader), images
src/mcp/file-types.ts    MIME types from names and magic bytes
src/uploads.ts           staging of files from the chat, encrypted in SQLite (upload links, base64 chunks)
src/web/upload.ts        the upload page and POST /upload/:token
src/app.ts               Express wiring: OAuth handlers, /mcp, pages, headers, rate limits
src/server.ts            entry point, housekeeping, shutdown
src/memory.ts            memory figures for the hourly log line and the admin page
src/soak/memory-soak.ts  memory soak: the real app, a fake Google, the request mix, figures after each checkpoint
```

## Dependencies and network

Runtime dependencies, pinned: `@modelcontextprotocol/server` (the MCP endpoint: it answers the 2026-07-28 protocol that claude.ai probes with first, via `server/discover`, and still serves 2025-era clients through the `initialize` handshake), `@modelcontextprotocol/sdk` (the OAuth authorization-server pieces), `express`, `express-rate-limit`, `zod`, and `pdfjs-dist` (Mozilla's pdf.js, used only to read the text layer of PDFs: nothing is rendered, and its optional native canvas package is not installed, see `.npmrc`). Word, Excel and PowerPoint files are read by the connector's own ZIP and XML code (`src/mcp/extract/`), with limits against zip bombs. Google is called with Node's built-in `fetch`; SQLite is Node's built-in `node:sqlite`.

Outbound connections: `accounts.google.com`, `oauth2.googleapis.com`, `gmail.googleapis.com`, `www.googleapis.com`, `sheets.googleapis.com`, Google's content host for Drive previews (`*.googleusercontent.com`, only the URL Drive hands out as a file's `thumbnailLink`), plus `claude.ai` to fetch Claude's client metadata document. Nothing else: no telemetry, no update check.

## Limitations

- Scanned PDFs have no text layer; Claude sees Drive's preview of the first page or, on request, has Google convert the file by OCR. Password-protected PDFs and Office files, legacy `.doc`/`.xls`/`.ppt` and OpenDocument files are not read directly (Google can convert the latter into Google files).
- claude.ai accepts tool results of about 150,000 characters (base64 images included), so images are shown inline up to 96 KB. Larger Drive images and PDF pages are shown through Drive's preview at the largest size that fits (1600, 1200, 800 or 512 px); a larger image attached to an email is seen by saving it to Drive first. A result that would still be too large loses its images and then has its longest text cut, with a note; `max_chars` is capped at 100,000.
- Transfers to and from Google time out after at most 150 s, inside claude.ai's 240 s limit per tool call, and a long transfer that timed out is not retried, so a slow send cannot land after Claude has given up on it.
- `drive_get_file` exports a spreadsheet's first tab as CSV; use the Sheets tools for the rest.
- Files in transit pass through the connector's memory, hence the 25 MB and 50 MB limits; only files staged from the chat are stored (encrypted, for a day).
- Files uploaded into a claude.ai chat cannot be handed to a connector. The user uploads them again through the link page from `create_upload_link` (or Claude's sandbox POSTs them there, when allowed to reach the server).
- Google Docs export to Markdown is best effort; the server falls back to plain text.
- One MCP server instance; a deploy restarts it (a few seconds of downtime, no lost data).
- Each copy is single-owner: its owners (`OWNER_EMAILS`) connect Claude to it and decide which Google accounts are linked. It is not built to serve unrelated users, and Google would require a verified app (with a yearly security assessment for Gmail) to offer that.
- ChatGPT is expected to work through dynamic client registration but has not been tried yet; reports are welcome.
