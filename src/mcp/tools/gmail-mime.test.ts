import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressHeader,
  buildMimeMessage,
  charsetOfContentType,
  decodeBase64Url,
  decodeEntities,
  encodeBase64Url,
  encodeHeader,
  extractBody,
  filenameParams,
  formatAddress,
  headerValue,
  htmlToText,
  parseAddresses,
  replyRecipients,
  rfc5322Date,
  stripQuotedHtml,
  stripQuotedText,
  type GmailPart,
} from './gmail-mime.js';

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** Splits a raw RFC 5322 message into unfolded headers and body. */
function parseRaw(raw: string): { headers: Record<string, string>; body: string } {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of head!.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: rest.join('\r\n\r\n') };
}

function decodeEncodedWords(s: string): string {
  return s.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_m, b: string) => Buffer.from(b, 'base64').toString('utf8')).replace(/\r\n /g, '');
}

test('decodeBase64Url accepts url-safe alphabet without padding and round-trips', () => {
  const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x00, 0x41]);
  const encoded = encodeBase64Url(bytes);
  assert.equal(encoded, bytes.toString('base64url'));
  assert.ok(!encoded.includes('+') && !encoded.includes('/') && !encoded.endsWith('='));
  assert.deepEqual(decodeBase64Url(encoded), bytes);
  assert.deepEqual(decodeBase64Url(bytes.toString('base64')), bytes, 'standard base64 with padding is accepted too');
});

test('headerValue is case-insensitive', () => {
  const headers = [{ name: 'Subject', value: 'Hi' }, { name: 'message-id', value: '<a@b>' }];
  assert.equal(headerValue(headers, 'subject'), 'Hi');
  assert.equal(headerValue(headers, 'Message-ID'), '<a@b>');
  assert.equal(headerValue(headers, 'From'), undefined);
  assert.equal(headerValue(undefined, 'From'), undefined);
});

test('encodeHeader leaves ASCII alone and B-encodes non-ASCII in short encoded-words', () => {
  assert.equal(encodeHeader('Plain subject: 100%'), 'Plain subject: 100%');
  assert.equal(encodeHeader('Line\r\nbreak'), 'Line break', 'CR/LF cannot appear in a header');
  const encoded = encodeHeader('Café ☕ réunion');
  assert.equal(encoded, '=?UTF-8?B?Q2Fmw6kg4piVIHLDqXVuaW9u?=');
  assert.equal(decodeEncodedWords(encoded), 'Café ☕ réunion');

  const long = 'Приглашение на встречу в четверг: обсуждение бюджета и планов на осень 🍂';
  const words = encodeHeader(long).split('\r\n ');
  assert.ok(words.length > 1, 'long subjects are split');
  for (const w of words) {
    assert.ok(w.length <= 75, `encoded-word too long: ${w.length}`);
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  }
  assert.equal(decodeEncodedWords(encodeHeader(long)), long, 'splitting never cuts a code point');
});

test('formatAddress quotes or encodes display names as needed', () => {
  assert.equal(formatAddress(undefined, 'a@example.com'), 'a@example.com');
  assert.equal(formatAddress('  ', 'a@example.com'), 'a@example.com');
  assert.equal(formatAddress('Ann Lee', 'a@example.com'), 'Ann Lee <a@example.com>');
  assert.equal(formatAddress('Lee, Ann', 'a@example.com'), '"Lee, Ann" <a@example.com>');
  assert.equal(formatAddress('Ann "The Boss" Lee', 'a@example.com'), '"Ann \\"The Boss\\" Lee" <a@example.com>');
  assert.equal(formatAddress('Zoë', 'z@example.com'), '=?UTF-8?B?Wm/Dqw==?= <z@example.com>');
});

test('parseAddresses handles names, quotes, commas inside quotes and bare addresses', () => {
  const parsed = parseAddresses('Ann Lee <ann@example.com>, "Doe, John" <john@example.com>, bob@example.com, <carol@example.com>');
  assert.deepEqual(parsed, [
    { name: 'Ann Lee', email: 'ann@example.com' },
    { name: 'Doe, John', email: 'john@example.com' },
    { email: 'bob@example.com' },
    { email: 'carol@example.com' },
  ]);
  assert.deepEqual(parseAddresses(undefined), []);
  assert.deepEqual(parseAddresses(' , '), []);
});

test('replyRecipients: plain reply goes to Reply-To, else From', () => {
  const original = { from: 'Ann <ann@example.com>', to: 'me@example.com, Bob <bob@example.com>', cc: 'carol@example.com' };
  assert.deepEqual(replyRecipients(original, 'me@example.com', false), { to: [{ name: 'Ann', email: 'ann@example.com' }], cc: [] });
  const withReplyTo = { ...original, replyTo: 'list@example.com' };
  assert.deepEqual(replyRecipients(withReplyTo, 'me@example.com', false).to, [{ email: 'list@example.com' }]);
});

test('replyRecipients: reply-all keeps To and Cc minus self and duplicates (case-insensitive)', () => {
  const original = {
    from: 'Ann <ann@example.com>',
    to: 'Me@Example.com, Bob <bob@example.com>, ann@example.com',
    cc: 'carol@example.com, BOB@example.com',
  };
  const r = replyRecipients(original, 'me@example.com', true);
  assert.deepEqual(r.to, [{ name: 'Ann', email: 'ann@example.com' }]);
  assert.deepEqual(r.cc, [{ name: 'Bob', email: 'bob@example.com' }, { email: 'carol@example.com' }]);
});

test('replyRecipients: replying to your own sent message targets the original recipients', () => {
  const r = replyRecipients({ from: 'me@example.com', to: 'ann@example.com, bob@example.com' }, 'me@example.com', false);
  assert.deepEqual(r.to.map((a) => a.email), ['ann@example.com', 'bob@example.com']);
});

test('buildMimeMessage: plain text message has the expected headers and base64 body', () => {
  const raw = buildMimeMessage({
    from: 'me@example.com',
    to: ['Ann <ann@example.com>', 'bob@example.com'],
    cc: ['carol@example.com'],
    bcc: ['dave@example.com'],
    replyTo: 'other@example.com',
    subject: 'Réunion demain',
    text: 'Bonjour à tous',
    inReplyTo: '<orig@example.com>',
    references: '<first@example.com> <orig@example.com>',
    date: new Date('2026-09-23T10:00:00Z'),
  });
  assert.ok(!/(^|[^\r])\n/.test(raw), 'CRLF line endings only');
  const { headers, body } = parseRaw(raw);
  assert.equal(headers['date'], 'Wed, 23 Sep 2026 10:00:00 +0000');
  assert.equal(headers['from'], 'me@example.com');
  assert.equal(headers['to'], 'Ann <ann@example.com>, bob@example.com');
  assert.equal(headers['cc'], 'carol@example.com');
  assert.equal(headers['bcc'], 'dave@example.com');
  assert.equal(headers['reply-to'], 'other@example.com');
  assert.equal(decodeEncodedWords(headers['subject']!), 'Réunion demain');
  assert.equal(headers['in-reply-to'], '<orig@example.com>');
  assert.equal(headers['references'], '<first@example.com> <orig@example.com>');
  assert.equal(headers['mime-version'], '1.0');
  assert.equal(headers['content-type'], 'text/plain; charset=UTF-8');
  assert.equal(headers['content-transfer-encoding'], 'base64');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Bonjour à tous');
});

test('buildMimeMessage: text parts are canonicalised to CRLF before base64 encoding', () => {
  const raw = buildMimeMessage({ from: 'me@example.com', to: ['a@example.com'], subject: 's', text: 'line 1\nline 2\r\nline 3\rline 4', html: '<p>a</p>\n<p>b</p>' });
  const { headers, body } = parseRaw(raw);
  const boundary = /boundary="([^"]+)"/.exec(headers['content-type']!)![1]!;
  const [textPart, htmlPart] = body.split(`--${boundary}`).slice(1, -1).map((p) => parseRaw(p.replace(/^\r\n/, '')));
  assert.equal(Buffer.from(textPart!.body, 'base64').toString(), 'line 1\r\nline 2\r\nline 3\r\nline 4');
  assert.equal(Buffer.from(htmlPart!.body, 'base64').toString(), '<p>a</p>\r\n<p>b</p>');
});

test('addressHeader folds long recipient lists at commas so no line exceeds 78 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => `Recipient Number ${i} <recipient${i}@example.com>`);
  const raw = buildMimeMessage({ from: 'me@example.com', to: many, cc: ['Zoë <zoe@example.com>'], subject: 's', text: 'x' });
  const head = raw.split('\r\n\r\n')[0]!;
  for (const line of head.split('\r\n')) assert.ok(line.length <= 78, `line too long (${line.length}): ${line}`);
  const to = head.replace(/\r\n[ \t]/g, ' ').split('\r\n').find((l) => l.startsWith('To:'))!;
  assert.equal(to, `To: ${many.join(', ')}`, 'unfolding restores the plain list');
  assert.ok(head.includes(',\r\n Recipient'), 'folds happen right after a comma');

  assert.equal(addressHeader('To', ['a@example.com', 'b@example.com']), 'To: a@example.com, b@example.com');
  const oversized = `"${'x'.repeat(100)}" <long@example.com>`;
  assert.equal(addressHeader('Cc', ['a@example.com', oversized]), `Cc: a@example.com,\r\n ${oversized}`, 'a mailbox longer than the limit gets its own line');
});

test('filenameParams uses RFC 2231 for non-ASCII names and plain quoting otherwise', () => {
  assert.equal(filenameParams('filename', 'report.pdf'), '; filename="report.pdf"');
  assert.equal(filenameParams('filename', 'say "hi".txt'), '; filename="say \\"hi\\".txt"');
  assert.equal(filenameParams('filename', 'отчёт 2026.pdf'), `; filename="_____ 2026.pdf"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%202026.pdf`);
  assert.equal(filenameParams('name', "it's*.txt"), `; name="it's*.txt"`, 'ASCII names are never percent-encoded');
  assert.equal(filenameParams('name', "é'*%.txt"), `; name="_'*%.txt"; name*=UTF-8''%C3%A9%27%2A%25.txt`, "RFC 2231 forbids ' * % in the encoded form");
  assert.equal(filenameParams('name', ''), '; name="attachment"');
});

test('buildMimeMessage: html gives multipart/alternative, attachments wrap it in multipart/mixed with 76-char base64 lines', () => {
  const content = Buffer.alloc(300, 0xab);
  const raw = buildMimeMessage({
    from: 'me@example.com',
    to: ['ann@example.com'],
    subject: 'Files',
    text: 'see attached',
    html: '<p>see <b>attached</b></p>',
    attachments: [{ filename: 'отчёт.bin', mimeType: 'application/octet-stream', content }],
  });
  const { headers, body } = parseRaw(raw);
  const mixed = /^multipart\/mixed; boundary="([^"]+)"$/.exec(headers['content-type']!);
  assert.ok(mixed, headers['content-type']);
  const mixedParts = body.split(`--${mixed![1]}`).slice(1, -1);
  assert.equal(mixedParts.length, 2);
  assert.ok(body.trimEnd().endsWith(`--${mixed![1]}--`), 'closing boundary');

  const alt = parseRaw(mixedParts[0]!.replace(/^\r\n/, ''));
  const altBoundary = /^multipart\/alternative; boundary="([^"]+)"$/.exec(alt.headers['content-type']!);
  assert.ok(altBoundary);
  const altParts = alt.body.split(`--${altBoundary![1]}`).slice(1, -1).map((p) => parseRaw(p.replace(/^\r\n/, '')));
  assert.equal(altParts[0]!.headers['content-type'], 'text/plain; charset=UTF-8');
  assert.equal(Buffer.from(altParts[0]!.body, 'base64').toString(), 'see attached');
  assert.equal(altParts[1]!.headers['content-type'], 'text/html; charset=UTF-8');
  assert.equal(Buffer.from(altParts[1]!.body, 'base64').toString(), '<p>see <b>attached</b></p>');

  const att = parseRaw(mixedParts[1]!.replace(/^\r\n/, ''));
  // Cyrillic filename: ASCII fallback plus the RFC 2231 form (not an RFC 2047 encoded-word, which is invalid inside a parameter).
  const encodedName = `UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.bin`;
  assert.equal(att.headers['content-type'], `application/octet-stream; name="_____.bin"; name*=${encodedName}`);
  assert.equal(att.headers['content-disposition'], `attachment; filename="_____.bin"; filename*=${encodedName}`);
  assert.equal(decodeURIComponent(encodedName.slice("UTF-8''".length)), 'отчёт.bin');
  const lines = att.body.trim().split('\r\n');
  assert.ok(lines.length > 1 && lines.every((l) => l.length <= 76), 'base64 wrapped at 76 chars');
  assert.deepEqual(Buffer.from(lines.join(''), 'base64'), content);
});

test('rfc5322Date uses a numeric zone', () => {
  assert.equal(rfc5322Date(new Date('2026-01-05T08:09:10Z')), 'Mon, 05 Jan 2026 08:09:10 +0000');
});

test('extractBody walks nested multipart, honours part charsets and lists attachments', () => {
  const latin1 = Buffer.from('Caf\xe9 au lait', 'latin1');
  const payload: GmailPart = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }], body: { data: b64url(latin1), size: latin1.length } },
          { partId: '0.1', mimeType: 'text/html', body: { data: b64url('<p>Caf&eacute; au lait</p>') } },
        ],
      },
      {
        partId: '1',
        mimeType: 'multipart/related',
        parts: [
          { partId: '1.0', mimeType: 'text/plain', body: { data: b64url('PS: see image') } },
          { partId: '1.1', mimeType: 'image/png', filename: '', headers: [{ name: 'Content-ID', value: '<img1>' }], body: { attachmentId: 'att-inline', size: 10 } },
        ],
      },
      { partId: '2', mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'att-pdf', size: 1234 } },
      {
        partId: '3',
        mimeType: 'text/plain',
        filename: 'notes.txt',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset="windows-1251"; name="notes.txt"' }],
        body: { data: b64url('small inline file'), size: 17 },
      },
    ],
  };
  const body = extractBody(payload);
  assert.equal(body.text, 'Café au lait\n\nPS: see image');
  assert.equal(body.html, '<p>Caf&eacute; au lait</p>');
  assert.deepEqual(body.attachments, [
    { partId: '1.1', attachmentId: 'att-inline', filename: 'inline-1.1.png', mimeType: 'image/png', size: 10, inline: true, embedded: true, data: undefined, charset: undefined },
    { partId: '2', attachmentId: 'att-pdf', filename: 'report.pdf', mimeType: 'application/pdf', size: 1234, inline: false, embedded: false, data: undefined, charset: undefined },
    { partId: '3', attachmentId: undefined, filename: 'notes.txt', mimeType: 'text/plain', size: 17, inline: false, embedded: false, data: b64url('small inline file'), charset: 'windows-1251' },
  ]);
});

test('charsetOfContentType reads the charset parameter, quoted or not', () => {
  assert.equal(charsetOfContentType('text/plain; charset=windows-1251'), 'windows-1251');
  assert.equal(charsetOfContentType('text/csv; charset="ISO-8859-1"; header=present'), 'ISO-8859-1');
  assert.equal(charsetOfContentType('text/plain'), undefined);
  assert.equal(charsetOfContentType(undefined), undefined);
});

test('extractBody handles single-part messages, unknown charsets and empty payloads', () => {
  const single: GmailPart = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=x-bogus' }], body: { data: b64url('héllo') } };
  assert.equal(extractBody(single).text, 'héllo', 'unknown charset falls back to UTF-8');
  assert.deepEqual(extractBody(undefined), { text: '', html: '', attachments: [] });
});

test('htmlToText drops script/style/head, keeps block structure, decodes entities and shows useful links', () => {
  const html = `<html><head><title>T</title><style>p{color:red}</style></head>
<body><script>alert(1)</script><!-- comment -->
<h1>Hello &amp; welcome</h1>
<p>First&nbsp;paragraph with
  source line breaks.</p>
<div>Line one</div><div>Line two</div>
<ul><li>One</li><li>Two &#169; &#x1F600;</li></ul>
<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>
<p>Visit <a href="https://example.com/docs?a=1&amp;b=2">our docs</a>, <a href="https://example.com/">example.com</a> or <a href="#top">top</a>.</p>
<p>Mail <a href="mailto:ann@example.com">ann@example.com</a></p>
</body></html>`;
  assert.equal(
    htmlToText(html),
    [
      'Hello & welcome',
      '',
      'First paragraph with source line breaks.',
      '',
      'Line one',
      'Line two',
      '- One',
      '- Two © 😀',
      '',
      'a b',
      'c d',
      '',
      'Visit our docs (https://example.com/docs?a=1&b=2), example.com or top.',
      '',
      'Mail ann@example.com',
    ].join('\n'),
  );
  assert.equal(htmlToText('a<br>b<br/>c'), 'a\nb\nc');
  assert.equal(htmlToText('   '), '');
});

test('decodeEntities keeps invalid numeric references verbatim', () => {
  assert.equal(decodeEntities('&#0; &#xD800; &unknown; &#65;'), '&#0; &#xD800; &unknown; A');
  assert.equal(decodeEntities('It&#39;s &quot;fine&quot;'), 'It\'s "fine"');
});

test('stripQuotedText removes quoted lines and trailing attributions', () => {
  const gmailStyle = ['Thanks, works for me.', '', 'On Mon, 21 Sep 2026 at 10:00, Ann Lee <ann@example.com>', 'wrote:', '', '> Does Thursday work?', '>', '> > earlier text', ''].join('\n');
  assert.equal(stripQuotedText(gmailStyle), 'Thanks, works for me.');

  const oneLine = 'Sure.\n\nOn Tue, Sep 22, 2026 at 9:00 AM Bob <bob@example.com> wrote:\n> ok?';
  assert.equal(stripQuotedText(oneLine), 'Sure.');

  const outlook = 'New text\n\n-----Original Message-----\nFrom: Ann\nSent: Monday\n\nOld body without markers';
  assert.equal(stripQuotedText(outlook), 'New text');

  const inline = 'Answer 1\n> question 1\nAnswer 2\n> question 2';
  assert.equal(stripQuotedText(inline), 'Answer 1\nAnswer 2');

  const notTrailing = 'On Monday Ann wrote:\nthat we should meet.\nAgreed.';
  assert.equal(stripQuotedText(notTrailing), notTrailing, 'an attribution followed by new text is kept');
});

test('stripQuotedText recognises localised attribution lines', () => {
  const french = 'Merci !\n\nLe lun. 21 sept. 2026 à 10:00, Ann Lee <ann@example.com> a écrit :\n> Jeudi ?';
  assert.equal(stripQuotedText(french), 'Merci !');
  const frenchWrapped = 'Merci !\n\nLe lun. 21 sept. 2026 à 10:00, Ann Lee <ann@example.com>\na écrit :\n> Jeudi ?';
  assert.equal(stripQuotedText(frenchWrapped), 'Merci !', 'Gmail may wrap the attribution onto two lines');
  const russian = 'Спасибо!\n\nпн, 21 сент. 2026 г. в 10:00, Иван Петров <ivan@example.com> написал(а):\n> Четверг?';
  assert.equal(stripQuotedText(russian), 'Спасибо!');
  const russianVerb = 'Ок.\n\n21.09.2026 10:00, Иван Петров пишет:\n> Четверг?';
  assert.equal(stripQuotedText(russianVerb), 'Ок.');
  const german = 'Danke.\n\nAm Mo., 21. Sept. 2026 um 10:00 Uhr schrieb Ann Lee <ann@example.com>:\n> Donnerstag?';
  assert.equal(stripQuotedText(german), 'Danke.');
  const spanish = 'Gracias.\n\nEl lun, 21 sept 2026 a las 10:00, Ann Lee <ann@example.com> escribió:\n> ¿Jueves?';
  assert.equal(stripQuotedText(spanish), 'Gracias.');
  const italian = 'Grazie.\n\nIl giorno lun 21 set 2026 alle ore 10:00 Ann Lee <ann@example.com> ha scritto:\n> Giovedì?';
  assert.equal(stripQuotedText(italian), 'Grazie.');
  const plainSentence = 'Ce que Ann a écrit :\nest correct.';
  assert.equal(stripQuotedText(plainSentence), plainSentence, 'a sentence that merely contains the verb is not an attribution');
});

test('stripQuotedHtml removes Gmail quote blocks, Outlook reply headers and blockquotes', () => {
  const gmail = '<div dir="ltr">Thanks!</div><br><div class="gmail_quote"><div>On Mon, Ann wrote:</div><blockquote>old</blockquote></div>';
  assert.equal(htmlToText(stripQuotedHtml(gmail)), 'Thanks!');
  const nested = '<p>Reply</p><blockquote>a<blockquote>b</blockquote>c</blockquote><p>sig</p>';
  assert.equal(htmlToText(stripQuotedHtml(nested)), 'Reply\n\nsig');
  const outlook = '<div>New</div><hr><div id="divRplyFwdMsg"><b>From:</b> Ann</div><div>old</div>';
  assert.equal(htmlToText(stripQuotedHtml(outlook)), 'New\n\n---');
});

test('stripQuotedHtml removes each blockquote separately so interleaved replies survive', () => {
  const interleaved = '<p>Answer 1</p><blockquote type="cite">question 1<blockquote>older</blockquote></blockquote><p>Answer 2</p><BLOCKQUOTE>question 2</BLOCKQUOTE><p>Bye</p>';
  assert.equal(htmlToText(stripQuotedHtml(interleaved)), 'Answer 1\n\nAnswer 2\n\nBye');
  assert.equal(htmlToText(stripQuotedHtml('<p>New</p><blockquote>never closed<p>more</p>')), 'New', 'an unclosed blockquote swallows the rest');
  assert.equal(htmlToText(stripQuotedHtml('<p>Stray</p></blockquote><p>kept</p>')), 'Stray\n\nkept', 'a stray closing tag is ignored');
});

test('extractBody tells images embedded in the body apart from attached files', () => {
  const part = (id: string, mimeType: string, filename: string, headers: { name: string; value: string }[]) => ({ partId: id, mimeType, filename, headers, body: { attachmentId: `att-${id}`, size: 10 } });
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/html', body: { data: b64url('<p>Hi <img src="cid:logo"></p>'), size: 30 } },
      // Retail-mail logos: named, inline disposition, referenced by Content-ID.
      part('2', 'image/png', 'Color.png', [{ name: 'Content-Disposition', value: 'inline; filename=Color.png' }, { name: 'Content-ID', value: '<logo>' }]),
      // A photo explicitly attached, even though it also carries a Content-ID.
      part('3', 'image/jpeg', 'holiday.jpg', [{ name: 'Content-Disposition', value: 'attachment; filename=holiday.jpg' }, { name: 'Content-ID', value: '<p1>' }]),
      // A named image with no Content-ID and no disposition: a plain attachment.
      part('4', 'image/png', 'scan.png', []),
      // Outlook invitations arrive as unnamed inline text/calendar: never hidden.
      part('5', 'text/calendar', '', []),
      part('6', 'application/pdf', 'Ticket.pdf', [{ name: 'Content-Disposition', value: 'attachment; filename=Ticket.pdf' }]),
    ],
  };
  const byName = Object.fromEntries(extractBody(payload).attachments.map((a) => [a.filename, a.embedded]));
  assert.deepEqual(byName, { 'Color.png': true, 'holiday.jpg': false, 'scan.png': false, 'inline-5.calendar': false, 'Ticket.pdf': false });
});
