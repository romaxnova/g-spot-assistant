import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MimeEditError,
  addParts,
  bodyEntity,
  headerValues,
  listAttachments,
  parseEntity,
  parseMessage,
  removeParts,
  replaceBody,
  serializeMessage,
  setHeader,
  type MimeEntity,
} from './gmail-mime-edit.js';

const crlf = (...lines: string[]) => lines.join('\r\n');
/** Test messages are byte strings: one character per byte, like the module works on. */
const bytes = (s: string) => Buffer.from(s, 'latin1');
const parse = (s: string) => parseMessage(bytes(s));
const serialize = (m: MimeEntity) => serializeMessage(m).toString('latin1');
const b64lines = (data: Buffer) => data.toString('base64').match(/.{1,76}/g)!.join('\r\n');

function assertRoundTrip(raw: string): MimeEntity {
  const message = parse(raw);
  assert.equal(serialize(message), raw);
  return message;
}

/** Edited trees must serialize to something that parses back to the same tree. */
function assertStable(message: MimeEntity): void {
  assert.deepEqual(parseMessage(serializeMessage(message)), message);
}

/** [partId, type] of every entity, depth first. */
function shape(entity: MimeEntity): [string, string][] {
  return [[entity.partId, entity.type], ...(entity.parts ?? []).flatMap(shape)];
}

function findPart(entity: MimeEntity, partId: string): MimeEntity | undefined {
  if (entity.partId === partId) return entity;
  for (const part of entity.parts ?? []) {
    const found = findPart(part, partId);
    if (found) return found;
  }
  return undefined;
}

const isEditError = (message: RegExp) => ({ name: 'MimeEditError', message });

// ---------------------------------------------------------------------------
// Fixtures: drafts as Gmail stores them
// ---------------------------------------------------------------------------

const PLAIN_HEADERS = [
  'MIME-Version: 1.0',
  'Date: Tue, 22 Sep 2026 09:14:03 +0200',
  'Message-ID: <CAF=3kq1xYz+wPq8r@mail.gmail.com>',
  'Subject: Lunch on Friday?',
  'From: Ann Example <ann@example.com>',
  'To: Bob Builder <bob@example.com>',
];
const PLAIN_TEXT = crlf('Hi Bob,', '', 'Are you free for lunch on Friday?', '', 'Ann', '');
const PLAIN_DRAFT = crlf(...PLAIN_HEADERS, 'Content-Type: text/plain; charset="UTF-8"', '', PLAIN_TEXT);

const ALT = '000000000000a1b2c3d4e5f60718';
const ALT_CONTENT_TYPE = `Content-Type: multipart/alternative; boundary="${ALT}"`;
const ALT_BODY = crlf(
  `--${ALT}`,
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Caf=C3=A9 at 10?',
  '',
  `--${ALT}`,
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<div dir=3D"ltr">Caf=C3=A9 at 10?</div>',
  '',
  `--${ALT}--`,
  '',
);
const ALT_HEADERS = [
  'MIME-Version: 1.0',
  'Date: Tue, 22 Sep 2026 10:01:44 +0200',
  'Message-ID: <CAF=4ab2cD3eF@mail.gmail.com>',
  'Subject: =?UTF-8?Q?Caf=C3=A9_tomorrow?=',
  'From: Ann Example <ann@example.com>',
  'To: bob@example.com',
];
const ALT_DRAFT = crlf(...ALT_HEADERS, ALT_CONTENT_TYPE, '', ALT_BODY);

// Gmail's web composer: text with a pasted image, plus an attached PDF.
const MIX = '000000000000f1a2b3c4d5e6f708';
const REL = '000000000000f1a2b3c4d5e6f707';
const ALT2 = '000000000000f1a2b3c4d5e6f706';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6d5d80000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'.repeat(3), 'latin1');
const IMAGE_PART = crlf(
  'Content-Type: image/png; name="chart.png"',
  'Content-Disposition: inline; filename="chart.png"',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <ii_m1abc2def0>',
  'X-Attachment-Id: ii_m1abc2def0',
  '',
  b64lines(PNG),
);
const PDF_PART = crlf(
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <f_m1abc2dg1>',
  'X-Attachment-Id: f_m1abc2dg1',
  '',
  b64lines(PDF),
);
const COMPOSER_ALT_PART = crlf(
  `Content-Type: multipart/alternative; boundary="${ALT2}"`,
  '',
  `--${ALT2}`,
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'See the chart:',
  '[image: chart.png]',
  '',
  `--${ALT2}`,
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<div dir="ltr">See the chart:<div><img src="cid:ii_m1abc2def0" alt="chart.png" width="120" height="80"><br></div></div>',
  '',
  `--${ALT2}--`,
);
const COMPOSER_BODY_PART = crlf(`Content-Type: multipart/related; boundary="${REL}"`, '', `--${REL}`, COMPOSER_ALT_PART, `--${REL}`, IMAGE_PART, `--${REL}--`);
const COMPOSER_HEADERS = [
  'MIME-Version: 1.0',
  'Date: Wed, 23 Sep 2026 08:30:00 +0200',
  'Message-ID: <CAF=9zz8yy7xx@mail.gmail.com>',
  'Subject: Q3 numbers',
  'From: Ann Example <ann@example.com>',
  'To: Bob Builder <bob@example.com>, carol@example.com',
  `Content-Type: multipart/mixed; boundary="${MIX}"`,
];
const COMPOSER_DRAFT = crlf(...COMPOSER_HEADERS, '', `--${MIX}`, COMPOSER_BODY_PART, `--${MIX}`, PDF_PART, `--${MIX}--`, '');

const REPLY_DRAFT = crlf(
  'MIME-Version: 1.0',
  'Date: Wed, 23 Sep 2026 18:02:11 +0200',
  'References: <CAB1a2b3c4@mail.gmail.com>',
  ' <CAB5d6e7f8@mail.gmail.com>',
  'In-Reply-To: <CAB5d6e7f8@mail.gmail.com>',
  'Message-ID: <CAC9z8y7x6@mail.gmail.com>',
  'Subject: Re: Contract review',
  'From: Ann at Work <ann.alias@example.org>',
  'To: Dave <dave@example.net>',
  'Cc: legal@example.net',
  'X-Custom-Header: keep me',
  'Content-Type: multipart/alternative; boundary="0000000000007c1d2e3f4a5b6c7d"',
  '',
  '--0000000000007c1d2e3f4a5b6c7d',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'Looks good to me.',
  '',
  'On Wed, Sep 23, 2026 at 5:00 PM Dave <dave@example.net> wrote:',
  '> Please review the attached contract.',
  '',
  '--0000000000007c1d2e3f4a5b6c7d',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<div dir="ltr">Looks good to me.</div><br><div class="gmail_quote">On Wed, Dave wrote:<blockquote>Please review</blockquote></div>',
  '',
  '--0000000000007c1d2e3f4a5b6c7d--',
  '',
);

// RFC 2046 5.1.1's own example: a boundary with a space, preamble, epilogue, a part without headers.
const RFC2046_EXAMPLE = crlf(
  'From: Nathaniel Borenstein <nsb@bellcore.com>',
  'To: Ned Freed <ned@innosoft.com>',
  'Date: Sun, 21 Mar 1993 23:56:48 -0800 (PST)',
  'Subject: Sample message',
  'MIME-Version: 1.0',
  'Content-type: multipart/mixed; boundary="simple boundary"',
  '',
  'This is the preamble.  It is to be ignored, though it',
  'is a handy place for composition agents to include an',
  'explanatory note to non-MIME conformant readers.',
  '',
  '--simple boundary',
  '',
  'This is implicitly typed plain US-ASCII text.',
  'It does NOT end with a linebreak.',
  '--simple boundary',
  'Content-type: text/plain; charset=us-ascii',
  '',
  'This is explicitly typed plain US-ASCII text.',
  'It DOES end with a linebreak.',
  '',
  '--simple boundary--',
  '',
  'This is the epilogue.  It is also to be ignored.',
  '',
);

// Thunderbird style: preamble line, quoted boundary of dashes and letters.
const TB = '------------8zQpX0aF3cUe1rV2Wn7Ys9Tb';
const THUNDERBIRD_DRAFT = crlf(
  'Content-Type: multipart/mixed; boundary="' + TB + '"',
  'Message-ID: <3f1c2d4e-5a6b-7c8d-9e0f-a1b2c3d4e5f6@example.com>',
  'Date: Thu, 24 Sep 2026 11:00:00 +0200',
  'MIME-Version: 1.0',
  'User-Agent: Mozilla Thunderbird',
  'Content-Language: en-US',
  'To: bob@example.com',
  'From: Ann <ann@example.com>',
  'Subject: Minutes',
  'X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0; DSN=0; uuencode=0;',
  ' attachmentreminder=0; deliveryformat=0',
  '',
  'This is a multi-part message in MIME format.',
  `--${TB}`,
  'Content-Type: text/plain; charset=UTF-8; format=flowed',
  'Content-Transfer-Encoding: 7bit',
  '',
  'Minutes attached.',
  '',
  `--${TB}`,
  'Content-Type: text/plain; charset=UTF-8; name="minutes.txt"',
  'Content-Disposition: attachment; filename="minutes.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  'MS4gQnVkZ2V0CjIuIFBsYW5zCg==',
  '',
  `--${TB}--`,
  '',
);

const NOTE_PART = crlf(
  'Content-Type: text/plain; charset=UTF-8; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  'aGVsbG8K',
);

// ---------------------------------------------------------------------------
// Parsing and round trips
// ---------------------------------------------------------------------------

test('parseMessage builds the tree of a Gmail composer draft with Gmail part ids', () => {
  const message = parse(COMPOSER_DRAFT);
  assert.deepEqual(message.headers, COMPOSER_HEADERS);
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/related'],
    ['0.0', 'multipart/alternative'],
    ['0.0.0', 'text/plain'],
    ['0.0.1', 'text/html'],
    ['0.1', 'image/png'],
    ['1', 'application/pdf'],
  ]);
  assert.equal(message.boundary, MIX);
  assert.equal(message.preamble, undefined);
  assert.equal(message.epilogue, '');
  assert.equal(message.body, undefined);
  const text = findPart(message, '0.0.0')!;
  assert.deepEqual(text.headers, ['Content-Type: text/plain; charset="UTF-8"']);
  assert.equal(text.body, 'See the chart:\r\n[image: chart.png]\r\n', 'the CRLF before a delimiter is not part of the body');
  const alternative = findPart(message, '0.0')!;
  assert.equal(alternative.epilogue, undefined);
  assert.equal(alternative.parts?.length, 2);
  assert.equal(findPart(message, '0.1')!.body, b64lines(PNG));
  assert.equal(findPart(message, '1')!.body, b64lines(PDF));
});

test('realistic drafts round-trip byte for byte', () => {
  for (const raw of [PLAIN_DRAFT, ALT_DRAFT, COMPOSER_DRAFT, REPLY_DRAFT, RFC2046_EXAMPLE, THUNDERBIRD_DRAFT]) assertRoundTrip(raw);
});

test('plain text draft is a single leaf', () => {
  const message = assertRoundTrip(PLAIN_DRAFT);
  assert.equal(message.type, 'text/plain');
  assert.equal(message.partId, '');
  assert.equal(message.body, PLAIN_TEXT);
  assert.equal(message.parts, undefined);
});

test('reply draft keeps folded References and threading headers raw', () => {
  const message = assertRoundTrip(REPLY_DRAFT);
  assert.equal(message.headers[2], 'References: <CAB1a2b3c4@mail.gmail.com>\r\n <CAB5d6e7f8@mail.gmail.com>');
  assert.equal(message.headers.length, 11);
  assert.deepEqual(shape(message), [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ]);
});

test('RFC 2046 example: preamble, epilogue, boundary with a space, part without headers', () => {
  const message = assertRoundTrip(RFC2046_EXAMPLE);
  assert.equal(message.type, 'multipart/mixed', 'header name and type are case-insensitive');
  assert.equal(message.boundary, 'simple boundary');
  assert.equal(
    message.preamble,
    crlf('This is the preamble.  It is to be ignored, though it', 'is a handy place for composition agents to include an', 'explanatory note to non-MIME conformant readers.', ''),
  );
  const [implicit, explicit] = message.parts!;
  assert.deepEqual(implicit!.headers, []);
  assert.equal(implicit!.type, 'text/plain');
  assert.equal(implicit!.body, 'This is implicitly typed plain US-ASCII text.\r\nIt does NOT end with a linebreak.');
  assert.equal(explicit!.body, 'This is explicitly typed plain US-ASCII text.\r\nIt DOES end with a linebreak.\r\n');
  assert.equal(message.epilogue, '\r\nThis is the epilogue.  It is also to be ignored.\r\n');
});

test('Thunderbird draft: preamble without blank line, folded unknown header', () => {
  const message = assertRoundTrip(THUNDERBIRD_DRAFT);
  assert.equal(message.preamble, 'This is a multi-part message in MIME format.');
  assert.equal(message.boundary, TB);
  assert.equal(message.headers[9], 'X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0; DSN=0; uuencode=0;\r\n attachmentreminder=0; deliveryformat=0');
});

test('LF-only and bare-CR input is normalized to CRLF', () => {
  assert.equal(serialize(parse(COMPOSER_DRAFT.replace(/\r\n/g, '\n'))), COMPOSER_DRAFT);
  assert.equal(serialize(parse(REPLY_DRAFT.replace(/\r\n/g, '\r'))), REPLY_DRAFT);
  const message = parse('Subject: x\nTo: y\r\n\nline one\rline two\n');
  assert.deepEqual(message.headers, ['Subject: x', 'To: y']);
  assert.equal(message.body, 'line one\r\nline two\r\n');
  const lfOnly = parse(ALT_DRAFT.replace(/\r\n/g, '\n'));
  assert.deepEqual(shape(lfOnly), shape(parse(ALT_DRAFT)));
});

test('every byte value survives a round trip', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 10 && b !== 13));
  const raw = Buffer.concat([
    Buffer.from('Subject: 8-bit \xe9t\xe9 \xc3\xa0\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n', 'latin1'),
    all,
    Buffer.from('\r\n'),
    all,
  ]);
  const out = serializeMessage(parseMessage(raw));
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, raw);
});

test('boundaries: quoted specials, unquoted with "=", folded with comments, RFC 2231 continuations', () => {
  const unquoted = crlf(
    'Content-Type: multipart/alternative; boundary=----=_Part_4_1234.5678',
    '',
    '------=_Part_4_1234.5678',
    'Content-Type: text/plain',
    '',
    'a',
    '------=_Part_4_1234.5678',
    'Content-Type: text/html',
    '',
    '<p>a</p>',
    '------=_Part_4_1234.5678--',
    '',
  );
  const m1 = assertRoundTrip(unquoted);
  assert.equal(m1.boundary, '----=_Part_4_1234.5678');
  assert.equal(m1.parts?.length, 2);

  const folded = crlf(
    'Content-Type: Multipart/Mixed;',
    '\tBOUNDARY = "b1=_x.y+z (not a comment)" (a real comment);',
    ' charset="us-ascii"',
    '',
    '--b1=_x.y+z (not a comment)',
    '',
    'one',
    '--b1=_x.y+z (not a comment)NOT A DELIMITER',
    '--b1=_x.y+z (not a comment)-- trailing text makes this not a close delimiter',
    '--b1=_x.y+z (not a comment)',
    '',
    'two',
    '--b1=_x.y+z (not a comment)--',
    '',
  );
  const m2 = assertRoundTrip(folded);
  assert.equal(m2.type, 'multipart/mixed');
  assert.equal(m2.boundary, 'b1=_x.y+z (not a comment)');
  assert.equal(m2.parts?.length, 2);
  assert.equal(
    m2.parts![0]!.body,
    crlf('one', '--b1=_x.y+z (not a comment)NOT A DELIMITER', '--b1=_x.y+z (not a comment)-- trailing text makes this not a close delimiter'),
  );

  const continued = crlf('Content-Type: multipart/mixed; boundary*0="abc"; boundary*1=def', '', '--abcdef', '', 'x', '--abcdef--', '');
  assert.equal(assertRoundTrip(continued).boundary, 'abcdef');
});

test('a nested boundary that extends the outer one does not split the outer multipart', () => {
  const raw = crlf(
    'Content-Type: multipart/mixed; boundary="abc"',
    '',
    '--abc',
    'Content-Type: multipart/alternative; boundary="abcdef"',
    '',
    '--abcdef',
    '',
    'plain',
    '--abcdef',
    'Content-Type: text/html',
    '',
    '<p>html</p>',
    '--abcdef--',
    '--abc',
    'Content-Type: application/pdf; name="a.pdf"',
    '',
    'JVBERi0=',
    '--abc--',
    '',
  );
  const message = assertRoundTrip(raw);
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'application/pdf'],
  ]);
});

test('transport padding after delimiter lines round-trips', () => {
  const raw = crlf(
    'Content-Type: multipart/mixed; boundary="p"',
    '',
    'preamble',
    '--p  ',
    'Content-Type: text/plain',
    '',
    'one',
    '--p\t',
    'Content-Type: application/octet-stream; name="two.bin"',
    '',
    'two',
    '--p-- \t',
    'epilogue',
    '',
  );
  const message = assertRoundTrip(raw);
  assert.equal(message.preamble, 'preamble');
  assert.equal(message.epilogue, 'epilogue\r\n');
  assert.deepEqual(
    message.parts!.map((p) => p.body),
    ['one', 'two'],
  );
  removeParts(message, ['1']);
  assert.equal(serialize(message), raw.replace('\r\n--p\t\r\nContent-Type: application/octet-stream; name="two.bin"\r\n\r\ntwo', ''));
  replaceBody(message, parseEntity(crlf('Content-Type: text/plain', '', 'new')));
  assert.equal(serialize(message), crlf('Content-Type: multipart/mixed; boundary="p"', '', 'preamble', '--p  ', 'Content-Type: text/plain', '', 'new', '--p-- \t', 'epilogue', ''));
});

test('missing close delimiter is tolerated and written on serialization', () => {
  const top = crlf('MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'hello', '--b', 'Content-Type: text/html', '', '<p>hello</p>', '');
  const message = parse(top);
  assert.equal(message.parts?.length, 2);
  assert.equal(message.parts![1]!.body, '<p>hello</p>');
  assert.equal(serialize(message), `${top}--b--\r\n`);
  assertStable(message);

  const truncated = crlf('Content-Type: multipart/mixed; boundary=b', '', '--b', '', 'cut off');
  assert.equal(serialize(parse(truncated)), `${truncated}\r\n--b--`);

  const nested = crlf(
    'Content-Type: multipart/mixed; boundary=outer',
    '',
    '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '',
    '--inner',
    '',
    'text',
    '--outer',
    'Content-Type: application/pdf; name=x.pdf',
    '',
    'JVBERi0=',
    '--outer--',
    '',
  );
  const n = parse(nested);
  assert.deepEqual(shape(n), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['1', 'application/pdf'],
  ]);
  assert.equal(serialize(n), nested.replace('text\r\n--outer', 'text\r\n--inner--\r\n--outer'));
});

test('multiparts without a usable boundary stay leaves', () => {
  const noParam = crlf('Content-Type: multipart/mixed', '', '--x', '', 'body', '--x--', '');
  const m1 = assertRoundTrip(noParam);
  assert.equal(m1.type, 'multipart/mixed');
  assert.equal(m1.parts, undefined);
  assert.equal(m1.body, crlf('--x', '', 'body', '--x--', ''));
  assert.equal(bodyEntity(m1), m1, 'an unparsed multipart/mixed is its own body');

  const noDelimiter = crlf('Content-Type: multipart/mixed; boundary=zzz', '', 'just text', '--zzzz', '');
  assert.equal(assertRoundTrip(noDelimiter).parts, undefined);

  const onlyClose = crlf('Content-Type: multipart/mixed; boundary=zzz', '', 'text', '--zzz--', '');
  assert.equal(assertRoundTrip(onlyClose).parts, undefined);

  const emptyBoundary = crlf('Content-Type: multipart/mixed; boundary=""', '', '--', '', 'x', '----', '');
  assert.equal(assertRoundTrip(emptyBoundary).parts, undefined);
});

test('message/rfc822 and message/global are leaves even when they contain multiparts', () => {
  const inner = crlf(
    'From: x@example.com',
    'Subject: original',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain',
    '',
    'inner text',
    '--inner--',
  );
  const raw = crlf(
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain',
    '',
    'Forwarding the thread.',
    '--outer',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="original.eml"',
    '',
    inner,
    '--outer',
    'Content-Type: message/global',
    '',
    inner,
    '--outer--',
    '',
  );
  const message = assertRoundTrip(raw);
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'message/rfc822'],
    ['2', 'message/global'],
  ]);
  assert.equal(message.parts![1]!.body, inner);
  assert.deepEqual(listAttachments(message), [
    { partId: '1', filename: 'original.eml', type: 'message/rfc822', size: inner.length, inline: false },
    { partId: '2', type: 'message/global', size: inner.length, inline: false },
  ]);
});

test('entities without an empty line: headers only, empty parts, body only', () => {
  const noCrlf = assertRoundTrip('Subject: x\r\nFrom: a@example.com');
  assert.deepEqual(noCrlf.headers, ['Subject: x', 'From: a@example.com']);
  assert.equal(noCrlf.body, '');
  assert.deepEqual(assertRoundTrip('Subject: x\r\n').headers, ['Subject: x']);
  assert.deepEqual(assertRoundTrip('').headers, []);
  const bodyOnly = assertRoundTrip('\r\nbody only');
  assert.deepEqual(bodyOnly.headers, []);
  assert.equal(bodyOnly.body, 'body only');

  const parts = crlf('Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '--b', '', '--b', '--b', '--b--', '');
  const message = assertRoundTrip(parts);
  assert.deepEqual(
    message.parts!.map((p) => [p.headers, p.body]),
    [
      [['Content-Type: text/plain'], ''],
      [[], ''],
      [[], ''],
      [[], ''],
    ],
  );
  // The malformed "--b CRLF --b" part gets its own line break once it has content.
  setHeader(message.parts![2]!, 'Content-Type', 'text/plain');
  assert.equal(serialize(message), parts.replace('--b\r\n--b\r\n--b--', '--b\r\nContent-Type: text/plain\r\n\r\n\r\n--b\r\n--b--'));
  assertStable(message);

  // An edited entity gets the canonical empty line.
  setHeader(noCrlf, 'To', 'b@example.com');
  assert.equal(serialize(noCrlf), 'Subject: x\r\nFrom: a@example.com\r\nTo: b@example.com\r\n\r\n');
});

test('Content-Type defaults and tolerance', () => {
  assert.equal(parse('Subject: x\r\n\r\nhi').type, 'text/plain');
  assert.equal(parse('Content-Type: garbage\r\n\r\nhi').type, 'text/plain');
  assert.equal(parse('Content-Type: \r\n\r\nhi').type, 'text/plain');
  assert.equal(parse('Content-Type: TEXT/HTML ; charset=utf-8\r\n\r\nhi').type, 'text/html');
  assert.equal(parse('Content-Type: (comment) image / png\r\n\r\nhi').type, 'image/png');
  assert.equal(parse('Content-Type : application/pdf\r\n\r\nhi').type, 'application/pdf', 'obsolete space before the colon');
  assert.equal(parse('Content-Type: image/gif\r\nContent-Type: text/html\r\n\r\nhi').type, 'image/gif', 'the first field counts');
});

test('multiparts nested deeper than 40 levels stay leaves and round-trip', () => {
  let raw = 'Content-Type: text/plain\r\n\r\ndeep';
  for (let i = 59; i >= 0; i--) raw = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${raw}\r\n--b${i}--`;
  const message = assertRoundTrip(raw);
  let entity = message;
  let depth = 0;
  while (entity.parts) {
    entity = entity.parts[0]!;
    depth++;
  }
  assert.equal(depth, 40);
  assert.equal(entity.type, 'multipart/mixed');
  assert.equal(entity.partId, Array(40).fill('0').join('.'));
  assert.ok(entity.body!.startsWith('--b40\r\n'));
});

test('malformed header lines are kept untouched and ignored by lookups', () => {
  const raw = crlf('From MAILER-DAEMON Fri Jul  8 12:08:34 2011', 'From: a@example.com', 'no colon here', 'Subject: s', '', 'x');
  const message = assertRoundTrip(raw);
  assert.equal(message.headers.length, 4);
  assert.deepEqual(headerValues(message, 'From'), ['a@example.com']);
  setHeader(message, 'From', 'b@example.com');
  assert.equal(serialize(message), raw.replace('From: a@example.com', 'From: b@example.com'));
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('headerValues unfolds, matches case-insensitively and keeps encoded-words', () => {
  const reply = parse(REPLY_DRAFT);
  assert.deepEqual(headerValues(reply, 'references'), ['<CAB1a2b3c4@mail.gmail.com> <CAB5d6e7f8@mail.gmail.com>']);
  assert.deepEqual(headerValues(reply, 'SUBJECT'), ['Re: Contract review']);
  assert.deepEqual(headerValues(reply, 'Bcc'), []);
  assert.deepEqual(headerValues(parse(ALT_DRAFT), 'Subject'), ['=?UTF-8?Q?Caf=C3=A9_tomorrow?=']);
  const received = parse(crlf('Received: from a', ' by b; Mon, 1 Jan 2026', 'Received: from c', 'Subject :  spaced  ', 'X-Note: voil\xc3\xa0', '', ''));
  assert.deepEqual(headerValues(received, 'Received'), ['from a by b; Mon, 1 Jan 2026', 'from c']);
  assert.deepEqual(headerValues(received, 'Subject'), ['spaced']);
  assert.deepEqual(headerValues(received, 'X-Note'), ['voil\xc3\xa0'], 'a trailing 0xA0 byte of UTF-8 is not whitespace');
});

test('setHeader replaces in place, appends, removes, and leaves every other byte alone', () => {
  const message = parse(REPLY_DRAFT);
  setHeader(message, 'To', 'Eve <eve@example.net>, "Doe, John" <john@example.net>');
  assert.equal(serialize(message), REPLY_DRAFT.replace('To: Dave <dave@example.net>', 'To: Eve <eve@example.net>, "Doe, John" <john@example.net>'));

  setHeader(message, 'cc', undefined);
  setHeader(message, 'Bcc', 'secret@example.net');
  const expected = REPLY_DRAFT.replace('To: Dave <dave@example.net>', 'To: Eve <eve@example.net>, "Doe, John" <john@example.net>')
    .replace('Cc: legal@example.net\r\n', '')
    .replace('boundary="0000000000007c1d2e3f4a5b6c7d"\r\n', 'boundary="0000000000007c1d2e3f4a5b6c7d"\r\nBcc: secret@example.net\r\n');
  assert.equal(serialize(message), expected);

  setHeader(message, 'Subject', '=?UTF-8?B?UmU6IFZlcnRyYWcgw7xiZXJwcsO8ZnQ=?=\r\n =?UTF-8?B?IChWMik=?=');
  assert.deepEqual(headerValues(message, 'subject'), ['=?UTF-8?B?UmU6IFZlcnRyYWcgw7xiZXJwcsO8ZnQ=?= =?UTF-8?B?IChWMik=?=']);
  setHeader(message, 'X-Absent', undefined);
  assert.equal(message.headers.filter((h) => h.startsWith('X-Absent')).length, 0);
  assertStable(message);
});

test('setHeader collapses repeated fields into one at the first position', () => {
  const message = parse(crlf('Cc: a@example.com', 'Subject: s', 'CC: b@example.com', 'cc: c@example.com', '', 'x'));
  setHeader(message, 'Cc', 'd@example.com');
  assert.deepEqual(message.headers, ['Cc: d@example.com', 'Subject: s']);
  setHeader(message, 'Subject', undefined);
  assert.deepEqual(message.headers, ['Cc: d@example.com']);
});

test('setHeader rejects header injection, raw non-ASCII and bad names without changing anything', () => {
  const message = parse(REPLY_DRAFT);
  for (const value of [
    'x\r\nBcc: evil@example.com',
    'x\nBcc: evil@example.com',
    'x\rBcc: evil@example.com',
    'café',
    'emoji \u{1F600}',
    'a\r\n \r\nbody',
    'a\r\n',
    'a\r\n\t',
    'nul\u0000',
  ]) {
    assert.throws(() => setHeader(message, 'Subject', value), isEditError(/Subject/), JSON.stringify(value));
  }
  for (const name of ['Bad Name', 'X:Y', '', 'Naïve']) {
    assert.throws(() => setHeader(message, name, 'v'), isEditError(/not a valid header name/));
  }
  assert.equal(serialize(message), REPLY_DRAFT);
});

test('setHeader on Content-Type updates the entity type', () => {
  const message = parse(PLAIN_DRAFT);
  setHeader(message, 'Content-Type', 'text/html; charset=UTF-8');
  assert.equal(message.type, 'text/html');
  assert.deepEqual(message.headers, [...PLAIN_HEADERS, 'Content-Type: text/html; charset=UTF-8']);
  setHeader(message, 'content-type', undefined);
  assert.equal(message.type, 'text/plain');
});

// ---------------------------------------------------------------------------
// Body entity and replacing the text
// ---------------------------------------------------------------------------

test('bodyEntity: the message unless multipart/mixed, else its first part that is not an attachment', () => {
  const plain = parse(PLAIN_DRAFT);
  assert.equal(bodyEntity(plain), plain);
  const alt = parse(ALT_DRAFT);
  assert.equal(bodyEntity(alt), alt);
  const composer = parse(COMPOSER_DRAFT);
  assert.equal(bodyEntity(composer), composer.parts![0]);

  const attachmentsFirst = parse(
    crlf(
      'Content-Type: multipart/mixed; boundary=x',
      '',
      '--x',
      'Content-Type: image/png',
      'Content-Disposition: inline; filename="photo.png"',
      '',
      'iVBORw0K',
      '--x',
      'Content-Type: application/pdf; name="named-only.pdf"',
      '',
      'JVBERi0=',
      '--x',
      'Content-Type: multipart/alternative; boundary=y',
      'Content-Disposition: attachment',
      '',
      '--y',
      '',
      'attached alternative',
      '--y--',
      '--x',
      'Content-Type: text/plain',
      '',
      'the text',
      '--x--',
    ),
  );
  assert.equal(bodyEntity(attachmentsFirst), attachmentsFirst.parts![3]);

  const onlyAttachments = parse(crlf('Content-Type: multipart/mixed; boundary=x', '', '--x', PDF_PART, '--x--', ''));
  assert.equal(bodyEntity(onlyAttachments), undefined);

  // A multipart with a name parameter is a container, not an attachment.
  const namedContainer = parse(crlf('Content-Type: multipart/mixed; boundary=x', '', '--x', 'Content-Type: multipart/alternative; boundary=y; name="odd"', '', '--y', '', 't', '--y--', '--x--', ''));
  assert.equal(bodyEntity(namedContainer), namedContainer.parts![0]);
});

const NEW_ALTERNATIVE = crlf(
  'Content-Type: multipart/alternative; boundary="=_new0123456789abcdef012345_alt"',
  '',
  '--=_new0123456789abcdef012345_alt',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  'SGVsbG8=',
  '--=_new0123456789abcdef012345_alt',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  'PGI+SGVsbG88L2I+',
  '--=_new0123456789abcdef012345_alt--',
  '',
);
const NEW_TEXT = crlf('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', 'TmV3IHRleHQ=');

test('replaceBody on a plain draft swaps only the Content-* fields and the content', () => {
  const message = parse(PLAIN_DRAFT);
  replaceBody(message, parseEntity(NEW_ALTERNATIVE));
  assert.deepEqual(message.headers, [...PLAIN_HEADERS, 'Content-Type: multipart/alternative; boundary="=_new0123456789abcdef012345_alt"']);
  assert.equal(message.type, 'multipart/alternative');
  assert.equal(message.body, undefined);
  assert.deepEqual(shape(message), [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ]);
  assert.equal(serialize(message), crlf(...PLAIN_HEADERS, NEW_ALTERNATIVE));
  assertStable(message);
});

test('replaceBody on a reply keeps threading headers and puts Content-* fields where the old ones were', () => {
  const reply = parse(REPLY_DRAFT);
  replaceBody(reply, parseEntity(NEW_TEXT));
  const expectedHead = REPLY_DRAFT.slice(0, REPLY_DRAFT.indexOf('Content-Type:'));
  assert.equal(serialize(reply), `${expectedHead}${NEW_TEXT}`);
  assert.equal(reply.type, 'text/plain');
  assert.equal(reply.parts, undefined);
  assertStable(reply);

  const shuffled = parse(crlf('From: a@example.com', 'Content-Type: text/plain', 'Subject: s', 'Content-Transfer-Encoding: 7bit', 'Content-Language: de', 'To: b@example.com', '', 'old'));
  const replacement = parseEntity(crlf('MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'X-Ignored: yes', 'Content-Transfer-Encoding: base64', '', 'PHA+bmV3PC9wPg=='));
  replaceBody(shuffled, replacement);
  assert.deepEqual(shuffled.headers, ['From: a@example.com', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'Subject: s', 'To: b@example.com']);
  assert.equal(shuffled.body, 'PHA+bmV3PC9wPg==');

  const bare = parse(crlf('From: a@example.com', 'Subject: s', '', 'old'));
  replaceBody(bare, parseEntity(NEW_TEXT));
  assert.deepEqual(bare.headers, ['From: a@example.com', 'Subject: s', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']);
});

test('replaceBody on the composer draft replaces the text and pasted image, keeps the PDF bytes', () => {
  const message = parse(COMPOSER_DRAFT);
  replaceBody(message, parseEntity(NEW_TEXT));
  assert.equal(serialize(message), COMPOSER_DRAFT.replace(COMPOSER_BODY_PART, NEW_TEXT));
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
  ]);
  assert.deepEqual(listAttachments(message), [{ partId: '1', filename: 'report.pdf', type: 'application/pdf', size: PDF.length, inline: false }]);
  assertStable(message);
});

test('replaceBody inserts the text first when a mixed message has none, and replaces a body after attachments in place', () => {
  const onlyAttachment = parse(crlf('From: a@example.com', 'Content-Type: multipart/mixed; boundary="x"', '', '--x', PDF_PART, '--x--', ''));
  replaceBody(onlyAttachment, parseEntity(NEW_TEXT));
  assert.equal(serialize(onlyAttachment), crlf('From: a@example.com', 'Content-Type: multipart/mixed; boundary="x"', '', '--x', NEW_TEXT, '--x', PDF_PART, '--x--', ''));
  assert.deepEqual(shape(onlyAttachment).map(([id]) => id), ['', '0', '1']);

  const textLast = parse(crlf('Content-Type: multipart/mixed; boundary="x"', '', '--x', PDF_PART, '--x', 'Content-Type: text/plain', '', 'old text', '--x--', ''));
  replaceBody(textLast, parseEntity(NEW_TEXT));
  assert.equal(serialize(textLast), crlf('Content-Type: multipart/mixed; boundary="x"', '', '--x', PDF_PART, '--x', NEW_TEXT, '--x--', ''));
});

test('replaceBody gives a mixed message a fresh boundary when the new text contains its delimiter', () => {
  const message = parse(crlf('Content-Type: multipart/mixed; boundary=abc; x-note="a;b"', '', '--abc', 'Content-Type: text/plain', '', 'old', '--abc', PDF_PART, '--abc--', ''));
  replaceBody(message, parseEntity(crlf('Content-Type: text/plain', '', 'I pasted this:', '--abc', 'and this', '')));
  assert.notEqual(message.boundary, 'abc');
  assert.match(message.boundary!, /^=_[0-9a-f]{24}$/);
  assert.deepEqual(headerValues(message, 'Content-Type'), [`multipart/mixed; x-note="a;b"; boundary="${message.boundary}"`]);
  const again = parseMessage(serializeMessage(message));
  assert.equal(again.parts?.length, 2);
  assert.equal(again.parts![0]!.body, 'I pasted this:\r\n--abc\r\nand this\r\n');
  assertStable(message);
});

// ---------------------------------------------------------------------------
// Removing parts
// ---------------------------------------------------------------------------

test('removeParts drops the PDF from the composer draft and leaves every other byte', () => {
  const message = parse(COMPOSER_DRAFT);
  const removed = removeParts(message, ['1']);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.type, 'application/pdf');
  assert.equal(removed[0]!.body, b64lines(PDF));
  assert.equal(serialize(message), COMPOSER_DRAFT.replace(`\r\n--${MIX}\r\n${PDF_PART}`, ''));
  assert.equal(message.type, 'multipart/mixed', 'a mixed message with one part stays as it is');
  assert.deepEqual(listAttachments(message), [{ partId: '0.1', filename: 'chart.png', type: 'image/png', size: PNG.length, inline: true }]);
  assertStable(message);
});

test('removeParts can remove an image pasted into the text', () => {
  const message = parse(COMPOSER_DRAFT);
  removeParts(message, ['0.1']);
  assert.equal(serialize(message), COMPOSER_DRAFT.replace(`\r\n--${REL}\r\n${IMAGE_PART}`, ''));
  assert.deepEqual(listAttachments(message).map((a) => a.partId), ['1']);
});

test('removeParts removes multiparts left empty and renumbers', () => {
  const message = parse(COMPOSER_DRAFT);
  const removed = removeParts(message, ['0.0.1', '0.0.0']);
  assert.deepEqual(removed.map((p) => p.type), ['text/html', 'text/plain']);
  assert.equal(serialize(message), COMPOSER_DRAFT.replace(`--${REL}\r\n${COMPOSER_ALT_PART}\r\n`, ''));
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/related'],
    ['0.0', 'image/png'],
    ['1', 'application/pdf'],
  ]);
  assertStable(message);
});

test('removeParts returns a removed container intact together with a part inside it, and ignores duplicate ids', () => {
  const message = parse(COMPOSER_DRAFT);
  const [alternative, html] = removeParts(message, ['0.0', '0.0.1', '0.0']);
  assert.equal(alternative!.type, 'multipart/alternative');
  assert.equal(alternative!.parts?.length, 2);
  assert.equal(alternative!.parts![1], html);
  assert.deepEqual(shape(message).map(([id]) => id), ['', '0', '0.0', '1']);
});

test('removeParts refuses unknown ids, the message and the body without changing anything', () => {
  const message = parse(COMPOSER_DRAFT);
  assert.throws(() => removeParts(message, ['9']), isEditError(/no part "9".*0, 0\.0, 0\.0\.0, 0\.0\.1, 0\.1, 1/));
  assert.throws(() => removeParts(message, ['']), isEditError(/whole message/));
  assert.throws(() => removeParts(message, ['0']), isEditError(/holds the message text/));
  assert.throws(() => removeParts(message, ['1', '2']), isEditError(/no part "2"/));
  assert.equal(serialize(message), COMPOSER_DRAFT, 'nothing removed when any id is refused');
  const error = (() => {
    try {
      removeParts(message, ['nope']);
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error instanceof MimeEditError);
  assert.ok(error instanceof Error);
});

test('removeParts inside a non-mixed message is allowed; emptying the message leaves an empty text/plain', () => {
  const alt = parse(ALT_DRAFT);
  removeParts(alt, ['1']);
  assert.equal(serialize(alt), crlf(...ALT_HEADERS, ALT_CONTENT_TYPE, '', ALT_BODY.slice(0, ALT_BODY.indexOf(`\r\n--${ALT}\r\nContent-Type: text/html`)), `--${ALT}--`, ''));

  const onlyAttachment = parse(crlf('From: a@example.com', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="x"', 'Content-Transfer-Encoding: 7bit', 'X-After: 1', '', '--x', PDF_PART, '--x--', ''));
  removeParts(onlyAttachment, ['0']);
  assert.equal(onlyAttachment.type, 'text/plain');
  assert.equal(onlyAttachment.body, '');
  assert.equal(onlyAttachment.parts, undefined);
  assert.equal(serialize(onlyAttachment), crlf('From: a@example.com', 'MIME-Version: 1.0', 'X-After: 1', '', ''));
  assertStable(onlyAttachment);
});

// ---------------------------------------------------------------------------
// Adding parts
// ---------------------------------------------------------------------------

test('addParts turns a plain draft into multipart/mixed, keeping every other header in place', () => {
  const message = parse(PLAIN_DRAFT);
  const pdf = parseEntity(PDF_PART);
  addParts(message, [pdf]);
  const boundary = message.boundary!;
  assert.match(boundary, /^=_[0-9a-f]{24}$/);
  assert.equal(message.type, 'multipart/mixed');
  assert.deepEqual(message.headers, [...PLAIN_HEADERS, `Content-Type: multipart/mixed; boundary="${boundary}"`]);
  const [first, second] = message.parts!;
  assert.deepEqual(first!.headers, ['Content-Type: text/plain; charset="UTF-8"']);
  assert.equal(first!.body, PLAIN_TEXT);
  assert.equal(second, pdf);
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
  ]);
  assert.equal(
    serialize(message),
    crlf(...PLAIN_HEADERS, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', '', PLAIN_TEXT, `--${boundary}`, PDF_PART, `--${boundary}--`, ''),
  );
  assert.equal(bodyEntity(message), first);
  assertStable(message);
});

test('addParts adds MIME-Version when missing and moves every Content-* field to the first part', () => {
  const message = parse(crlf('From: a@example.com', 'Content-Type: text/plain', 'Subject: hi', 'Content-Transfer-Encoding: 7bit', 'X-Mailer: test', '', 'hello', ''));
  addParts(message, [parseEntity(NOTE_PART)]);
  assert.deepEqual(message.headers, ['From: a@example.com', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${message.boundary}"`, 'Subject: hi', 'X-Mailer: test']);
  assert.deepEqual(message.parts![0]!.headers, ['Content-Type: text/plain', 'Content-Transfer-Encoding: 7bit']);
  assertStable(message);

  const bare = parse(crlf('From: a@example.com', 'Subject: hi', '', 'hello', ''));
  addParts(bare, [parseEntity(NOTE_PART)]);
  assert.deepEqual(bare.headers, ['From: a@example.com', 'Subject: hi', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${bare.boundary}"`]);
  assert.deepEqual(bare.parts![0]!.headers, []);
  assert.equal(bare.parts![0]!.body, 'hello\r\n');
  assertStable(bare);
});

test('addParts on an alternative draft nests the alternative as the first part', () => {
  const message = parse(ALT_DRAFT);
  addParts(message, [parseEntity(NOTE_PART)]);
  const boundary = message.boundary!;
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'text/plain'],
  ]);
  assert.equal(serialize(message), crlf(...ALT_HEADERS, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ALT_CONTENT_TYPE, '', ALT_BODY, `--${boundary}`, NOTE_PART, `--${boundary}--`, ''));
  assert.notEqual(boundary, ALT);
  assertStable(message);
});

test('addParts appends to an existing mixed message without touching its bytes', () => {
  const message = parse(COMPOSER_DRAFT);
  const note = parseEntity(NOTE_PART);
  const pdf = parseEntity(PDF_PART);
  addParts(message, [note, pdf]);
  assert.equal(message.boundary, MIX);
  assert.equal(serialize(message), COMPOSER_DRAFT.replace(`--${MIX}--\r\n`, `--${MIX}\r\n${NOTE_PART}\r\n--${MIX}\r\n${PDF_PART}\r\n--${MIX}--\r\n`));
  assert.deepEqual(listAttachments(message).map((a) => [a.partId, a.filename]), [
    ['0.1', 'chart.png'],
    ['1', 'report.pdf'],
    ['2', 'note.txt'],
    ['3', 'report.pdf'],
  ]);
  addParts(message, []);
  assert.equal(message.parts?.length, 4);
  assertStable(message);
});

test('addParts gives a mixed message a fresh boundary when a new part contains its delimiter', () => {
  const raw = crlf('Content-Type: multipart/mixed; boundary=abc', '', '--abc', 'Content-Type: text/plain', '', 'hi', '--abc--', '');
  const message = parse(raw);
  const copy = parseEntity(crlf('Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="copy.eml"', '', raw));
  addParts(message, [copy]);
  assert.match(message.boundary!, /^=_[0-9a-f]{24}$/);
  assert.deepEqual(headerValues(message, 'content-type'), [`multipart/mixed; boundary="${message.boundary}"`]);
  const again = parseMessage(serializeMessage(message));
  assert.equal(again.parts?.length, 2);
  assert.equal(again.parts![1]!.body, raw);
  assertStable(message);
});

test('edits chain: add, remove, replace, set headers', () => {
  const message = parse(REPLY_DRAFT);
  addParts(message, [parseEntity(PDF_PART), parseEntity(NOTE_PART)]);
  removeParts(message, ['1']);
  replaceBody(message, parseEntity(NEW_ALTERNATIVE));
  setHeader(message, 'Subject', 'Re: Contract review (v2)');
  assert.deepEqual(shape(message), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'text/plain'],
  ]);
  assert.deepEqual(headerValues(message, 'In-Reply-To'), ['<CAB5d6e7f8@mail.gmail.com>']);
  assert.equal(message.headers[2], 'References: <CAB1a2b3c4@mail.gmail.com>\r\n <CAB5d6e7f8@mail.gmail.com>');
  assert.deepEqual(headerValues(message, 'From'), ['Ann at Work <ann.alias@example.org>']);
  assert.deepEqual(headerValues(message, 'X-Custom-Header'), ['keep me']);
  assertStable(message);
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

test('listAttachments on the composer draft: pasted image inline, PDF attached, exact sizes', () => {
  assert.deepEqual(listAttachments(parse(COMPOSER_DRAFT)), [
    { partId: '0.1', filename: 'chart.png', type: 'image/png', size: PNG.length, inline: true },
    { partId: '1', filename: 'report.pdf', type: 'application/pdf', size: PDF.length, inline: false },
  ]);
  assert.deepEqual(listAttachments(parse(PLAIN_DRAFT)), []);
  assert.deepEqual(listAttachments(parse(REPLY_DRAFT)), []);
  assert.deepEqual(listAttachments(parse(THUNDERBIRD_DRAFT)), [{ partId: '1', filename: 'minutes.txt', type: 'text/plain', size: 19, inline: false }]);
});

test('listAttachments decodes RFC 2231, RFC 2047, raw UTF-8 and quoted file names', () => {
  const privet = Buffer.from('Привет.txt');
  const splitWords = `=?UTF-8?B?${privet.subarray(0, 3).toString('base64')}?= =?UTF-8?B?${privet.subarray(3).toString('base64')}?=`;
  const raw = crlf(
    'Content-Type: multipart/mixed; boundary="f"',
    '',
    '--f',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'See attached.',
    '--f',
    'Content-Type: application/pdf; name="otchet.pdf"',
    "Content-Disposition: attachment; filename=\"otchet.pdf\"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--f',
    'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition: attachment;',
    " filename*0*=UTF-8''Quarterly%20;",
    ' filename*1="report ";',
    ' filename*2*=%E2%80%93%20Q3.xlsx',
    'Content-Transfer-Encoding: base64',
    '',
    'UEsDBA==',
    '--f',
    `Content-Type: text/plain; name="${splitWords}"`,
    `Content-Disposition: attachment; filename="${splitWords}"`,
    'Content-Transfer-Encoding: 7bit',
    '',
    'hello',
    '--f',
    'Content-Type: application/msword; name="=?ISO-8859-1?Q?caf=E9_menu.doc?="',
    '',
    'DOC',
    '--f',
    'Content-Type: application/pdf',
    "Content-Disposition: attachment; filename*=iso-8859-1'fr'r%E9sum%E9.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    'QUJD\r\nREVG\r\nRw==',
    '--f',
    'Content-Type: application/pdf',
    `Content-Disposition: attachment; filename="${Buffer.from('naïve.pdf').toString('latin1')}"`,
    '',
    '',
    '--f',
    'Content-Type: image/gif',
    'Content-Disposition: attachment; FILENAME="say \\"hi\\" (2).gif"',
    '',
    'R0lG',
    '--f',
    'Content-Type: text/calendar; method=REQUEST',
    '',
    'BEGIN:VCALENDAR',
    '--f--',
    '',
  );
  const message = assertRoundTrip(raw);
  assert.deepEqual(listAttachments(message), [
    { partId: '1', filename: 'отчёт.pdf', type: 'application/pdf', size: 9, inline: false },
    { partId: '2', filename: 'Quarterly report – Q3.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4, inline: false },
    { partId: '3', filename: 'Привет.txt', type: 'text/plain', size: 5, inline: false },
    { partId: '4', filename: 'café menu.doc', type: 'application/msword', size: 3, inline: false },
    { partId: '5', filename: 'résumé.pdf', type: 'application/pdf', size: 7, inline: false },
    { partId: '6', filename: 'naïve.pdf', type: 'application/pdf', size: 0, inline: false },
    { partId: '7', filename: 'say "hi" (2).gif', type: 'image/gif', size: 4, inline: false },
    { partId: '8', type: 'text/calendar', size: 15, inline: false },
  ]);
});

test('listAttachments: nameless images in multipart/related are inline, a whole-message attachment is listed as ""', () => {
  const related = parse(
    crlf(
      'Content-Type: multipart/related; boundary=r',
      '',
      '--r',
      'Content-Type: text/html',
      '',
      '<img src="cid:logo">',
      '--r',
      'Content-Type: image/png',
      'Content-ID: <logo>',
      'Content-Transfer-Encoding: base64',
      '',
      b64lines(PNG),
      '--r',
      'Content-Type: image/png; name="attached.png"',
      'Content-Disposition: attachment',
      'Content-Transfer-Encoding: BASE64',
      '',
      b64lines(PNG),
      '--r--',
      '',
    ),
  );
  assert.deepEqual(listAttachments(related), [
    { partId: '1', type: 'image/png', size: PNG.length, inline: true },
    { partId: '2', filename: 'attached.png', type: 'image/png', size: PNG.length, inline: false },
  ]);

  const whole = parse(crlf('From: scanner@example.com', 'MIME-Version: 1.0', 'Content-Type: application/pdf; name="scan.pdf"', 'Content-Disposition: attachment; filename="scan.pdf"', 'Content-Transfer-Encoding: base64', '', b64lines(PDF), ''));
  assert.deepEqual(listAttachments(whole), [{ partId: '', filename: 'scan.pdf', type: 'application/pdf', size: PDF.length, inline: false }]);
  assert.throws(() => removeParts(whole, ['']), isEditError(/whole message/));
});

// ---------------------------------------------------------------------------
// New parts
// ---------------------------------------------------------------------------

test('parseEntity parses a part built elsewhere, normalizing line breaks', () => {
  const part = parseEntity('Content-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: base64\n\naGk=\n');
  assert.deepEqual(part.headers, ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']);
  assert.equal(part.body, 'aGk=\r\n');
  assert.equal(part.partId, '');
  assert.deepEqual(shape(parseEntity(NEW_ALTERNATIVE)), [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ]);
  assert.throws(() => parseEntity('Content-Type: text/plain\r\n\r\nПривет'), isEditError(/not encoded/));
  assert.equal(parseEntity('Content-Type: text/plain\r\n\r\ncaf\xe9').body, 'caf\xe9', 'single bytes are accepted as they are');
});

test('MimeEditError is an Error with its own name', () => {
  const error = new MimeEditError('x');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'MimeEditError');
  assert.equal(error.message, 'x');
});
