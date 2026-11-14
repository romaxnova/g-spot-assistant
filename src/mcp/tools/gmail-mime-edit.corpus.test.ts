/**
 * Corpus tests for the draft editor in gmail-mime-edit.ts.
 *
 * They were written from the module's specification alone, independently of
 * its implementation, so that the two do not share blind spots. The corpus
 * reproduces, as closely as possible, what real clients store: Gmail web
 * drafts (alternative, pasted images, attachments, replies, forwards),
 * Apple Mail and iPhone Mail, Thunderbird, Outlook (Exchange and classic),
 * mutt with LF line endings, Python's email package, a scanner, a cron mail,
 * and drafts this connector builds itself.
 *
 * Expected results are computed with small independent helpers (a header
 * splitter and a top-level delimiter finder written here), never by asking the
 * module under test. Where the specification leaves room, the assertion
 * follows the most reasonable reading and says so in a "spec reading" comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMimeMessage } from './gmail-mime.js';
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

// ---------------------------------------------------------------------------
// Helpers (independent of the module under test)
// ---------------------------------------------------------------------------

const CRLF = '\r\n';
const crlf = (...lines: string[]) => lines.join(CRLF);
const lf = (...lines: string[]) => lines.join('\n');
const bytes = (text: string) => Buffer.from(text, 'utf8');

/** The line-break normalisation the parser applies first: bare LF and bare CR become CRLF. */
const normalize = (s: string) => s.replace(/\r\n|\r|\n/g, CRLF);

/** Deterministic pseudo-random file content behind a real magic number, so sizes and base64 padding are exact. */
function fakeFile(magic: string, size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  out.write(magic, 'latin1');
  let x = seed >>> 0 || 1;
  for (let i = magic.length; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** Base64 in lines of `width` characters (Gmail, Apple and Outlook use 76, Thunderbird 72). */
function b64(data: Buffer, width = 76): string {
  return (data.toString('base64').match(new RegExp(`.{1,${width}}`, 'g')) ?? []).join(CRLF);
}

const serialize = (m: MimeEntity) => serializeMessage(m).toString('latin1');
const roundTrip = (raw: string | Buffer) => serialize(parseMessage(typeof raw === 'string' ? Buffer.from(raw, 'latin1') : raw));
const reparse = (text: string) => parseMessage(Buffer.from(text, 'latin1'));

type Tree = Array<[partId: string, type: string]>;

function* walk(e: MimeEntity): Generator<MimeEntity> {
  yield e;
  for (const p of e.parts ?? []) yield* walk(p);
}

/** Pre-order list of [partId, type]. */
const tree = (e: MimeEntity): Tree => [...walk(e)].map((x) => [x.partId, x.type]);

/** Structural invariants of a parsed tree: leaves carry a body, multiparts carry a boundary and parts. */
function assertShape(msg: MimeEntity): void {
  for (const e of walk(msg)) {
    if (e.parts) assert.equal(typeof e.boundary, 'string', `multipart ${e.partId} has a boundary`);
    else assert.equal(typeof e.body, 'string', `leaf ${JSON.stringify(e.partId)} has a body`);
  }
}

interface Attachment {
  partId: string;
  filename: string | undefined;
  type: string;
  size: number;
  inline: boolean;
}

const att = (partId: string, filename: string | undefined, type: string, content: Buffer | number, inline = false): Attachment => ({
  partId,
  filename,
  type,
  size: typeof content === 'number' ? content : content.length,
  inline,
});

/** listAttachments with a fixed key set, so a missing filename and filename: undefined compare equal. */
const attachmentsOf = (m: MimeEntity): Attachment[] =>
  listAttachments(m).map((a) => ({ partId: a.partId, filename: a.filename, type: a.type, size: a.size, inline: a.inline }));

/** Field name of a raw header field, lower-cased; undefined for a malformed line. */
const fieldName = (field: string) => /^([!-9;-~]+):/.exec(field)?.[1]?.toLowerCase();
const isContentField = (field: string) => fieldName(field)?.startsWith('content-') ?? false;
const contentFields = (fields: string[]) => fields.filter(isContentField);
const otherFields = (fields: string[]) => fields.filter((f) => !isContentField(f));

/** Header fields of a CRLF message (folded lines joined) and everything from the blank line on. */
function splitHead(text: string): { fields: string[]; tail: string } {
  const end = text.startsWith(CRLF) ? 0 : text.indexOf(CRLF + CRLF) + 2;
  assert.ok(end >= 0, 'corpus messages have a header block');
  const fields: string[] = [];
  for (const line of text.slice(0, end).split(CRLF).slice(0, -1)) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1] += CRLF + line;
    else fields.push(line);
  }
  return { fields, tail: text.slice(end) };
}

const joinHead = (fields: string[], tail: string) => fields.map((f) => f + CRLF).join('') + tail;

/** What setHeader is specified to do, applied to a plain list of fields. */
function setField(fields: string[], name: string, value: string | undefined): string[] {
  const wanted = name.toLowerCase();
  const first = fields.findIndex((f) => fieldName(f) === wanted);
  const out: string[] = [];
  fields.forEach((f, i) => {
    if (fieldName(f) !== wanted) out.push(f);
    else if (i === first && value !== undefined) out.push(`${name}: ${value}`);
  });
  if (first < 0 && value !== undefined) out.push(`${name}: ${value}`);
  return out;
}

/** An entity as text: header fields, blank line, body (RFC 2046 body-part). */
const entityText = (headers: string[], body: string) => headers.map((h) => h + CRLF).join('') + CRLF + body;

/**
 * Offsets of the top-level delimiter lines of a multipart message: `opens`
 * are the line starts of "--boundary", `close` of "--boundary--", and each
 * part runs from after its delimiter line's CRLF to the CRLF that belongs to
 * the next delimiter (RFC 2046). Corpus messages have no transport padding.
 */
function topParts(text: string, boundary: string): { opens: number[]; close: number; parts: Array<{ start: number; end: number }> } {
  const opens: number[] = [];
  let close = -1;
  let pos = splitHead(text).fields.length ? text.indexOf(CRLF + CRLF) + 4 : 2;
  while (pos <= text.length) {
    const eol = text.indexOf(CRLF, pos);
    const line = text.slice(pos, eol < 0 ? text.length : eol);
    if (line === `--${boundary}`) opens.push(pos);
    else if (line === `--${boundary}--`) {
      close = pos;
      break;
    }
    if (eol < 0) break;
    pos = eol + 2;
  }
  assert.ok(opens.length > 0 && close > 0, `delimiters of ${boundary} found`);
  const parts = opens.map((start, i) => ({ start: text.indexOf(CRLF, start) + 2, end: (opens[i + 1] ?? close) - 2 }));
  return { opens, close, parts };
}

const idPath = (id: string) => (id === '' ? [] : id.split('.').map(Number));
const within = (id: string, ancestor: string) => ancestor === '' || id === ancestor || id.startsWith(`${ancestor}.`);
const joinId = (prefix: string, id: string) => (id === '' ? prefix : prefix === '' ? id : `${prefix}.${id}`);

function sortTree(t: Tree): Tree {
  return [...t].sort(([a], [b]) => {
    const x = idPath(a);
    const y = idPath(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  });
}

/** Id of a surviving part after the part `removed` (and its subtree) is taken out of its parent. */
function idAfterRemoval(id: string, removed: string): string {
  const r = idPath(removed);
  const p = idPath(id);
  const d = r.length - 1;
  if (p.length > d && p.slice(0, d).join('.') === r.slice(0, d).join('.') && p[d]! > r[d]!) p[d] = p[d]! - 1;
  return p.join('.');
}

const removeFromTree = (t: Tree, removed: string): Tree =>
  t.filter(([id]) => !within(id, removed)).map(([id, type]): [string, string] => [idAfterRemoval(id, removed), type]);

// ---------------------------------------------------------------------------
// Files carried by the corpus
// ---------------------------------------------------------------------------

const PNG_CHART = fakeFile('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', 1234, 11);
const PDF_CONTRACT = fakeFile('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 5000, 12);
const DOCX_ANNEX = fakeFile('PK\x03\x04\x14\x00\x06\x00', 3001, 13);
const PNG_LOGO = fakeFile('\x89PNG\r\n\x1a\n', 999, 14);
const PDF_INVOICE = fakeFile('%PDF-1.4\n', 2051, 15);
const JPEG_PHOTO = fakeFile('\xff\xd8\xff\xe0\x00\x10JFIF\x00', 4096, 16);
const PNG_FLOORPLAN = fakeFile('\x89PNG\r\n\x1a\n', 1500, 17);
const PDF_REPORT = fakeFile('%PDF-1.5\n', 2222, 18);
const PNG_TB_CHART = fakeFile('\x89PNG\r\n\x1a\n', 800, 19);
const CSV_Q3 = bytes('region,revenue\r\nEMEA,1200\r\nAPAC,950\r\n');
const PNG_SIGNATURE = fakeFile('\x89PNG\r\n\x1a\n', 431, 20);
const DOCX_CONTRACT = fakeFile('PK\x03\x04\x14\x00\x06\x00', 2468, 21);
const PDF_CV = fakeFile('%PDF-1.6\n', 1777, 22);
const PDF_SCAN = fakeFile('%PDF-1.3\n', 3333, 23);
const CSV_EXPORT = bytes('date,amount\n2026-09-23,12.50\n2026-09-24,7.25\n');
const PDF_SLIDES = fakeFile('%PDF-1.7\n', 1024, 24);
const PDF_CUT = fakeFile('%PDF-1.4\n', 600, 25);
const PDF_OVERVIEW = fakeFile('%PDF-1.7\n', 1900, 26);
const JPEG_SMALL = fakeFile('\xff\xd8\xff\xe0\x00\x10JFIF\x00', 700, 27);
const PDF_MINUTES = fakeFile('%PDF-1.7\n', 1337, 28);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ---------------------------------------------------------------------------
// New content, as the connector builds it (ASCII, CRLF)
// ---------------------------------------------------------------------------

/** A new attachment entity, shaped like the connector's attachment parts. */
const NEW_ATTACHMENT = crlf(
  'Content-Type: application/pdf; name="minutes.pdf"',
  'Content-Disposition: attachment; filename="minutes.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PDF_MINUTES),
);
const newAttachment = (partId: string) => att(partId, 'minutes.pdf', 'application/pdf', PDF_MINUTES);

const NEW_ALT = '=_4f1c2d3e4f5a6b7c8d9e0f1a_alt';
/** A new text+HTML body, shaped like the connector's multipart/alternative (it ends with CRLF after the close delimiter). */
const NEW_BODY = crlf(
  `Content-Type: multipart/alternative; boundary="${NEW_ALT}"`,
  '',
  `--${NEW_ALT}`,
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64(bytes('Updated text — ünïcödé\r\n')),
  `--${NEW_ALT}`,
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64(bytes('<p>Updated text — ünïcödé</p>')),
  `--${NEW_ALT}--`,
  '',
);
const NEW_BODY_TREE: Tree = [
  ['', 'multipart/alternative'],
  ['0', 'text/plain'],
  ['1', 'text/html'],
];

/** A new plain-text body. */
const NEW_TEXT = crlf('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(bytes('Short and sweet.\r\n')));

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  /** The message as stored, line endings as the client wrote them. */
  raw: Buffer;
  /** Boundary of the top-level multipart, when the message is one. */
  boundary?: string;
  tree: Tree;
  /** partId of bodyEntity, or null when there is none. */
  body: string | null;
  attachments: Attachment[];
  /** False for the message that lacks its close delimiter: serialization adds one, so byte-exact checks do not apply. */
  exact?: false;
  /** Leave out of the generic replaceBody check (see the case). */
  skipReplaceBody?: true;
}

const G1 = '000000000000c5a2f3063fa1b2c3';
const gmailAlternative: Case = {
  name: 'Gmail web draft, text and HTML',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Wed, 23 Sep 2026 10:15:02 +0200',
      'Message-ID: <CAJk3f9xQm7p2Lr8Vd5n1Wb0YtE6uHc4sZa9gKo3iN2fPq@mail.gmail.com>',
      'Subject: Budget review',
      'From: Sebastian Ko <seb@example.com>',
      'To: Ann Lee <ann@example.com>, Bob Stone <bob@example.net>',
      `Content-Type: multipart/alternative; boundary="${G1}"`,
      '',
      `--${G1}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hi Ann,',
      '',
      'Here are the Q3 numbers =E2=80=94 see the summary below.',
      '',
      'Thanks,',
      'Sebastian',
      '',
      `--${G1}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<div dir=3D"ltr"><div>Hi Ann,</div><div><br></div><div>Here are the Q3 numbe=',
      'rs =E2=80=94 see the <b>summary</b> below.</div><div><br></div><div>Thanks,=',
      '</div><div>Sebastian</div></div>',
      '',
      `--${G1}--`,
      '',
    ),
  ),
  boundary: G1,
  tree: [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ],
  body: '',
  attachments: [],
};

const G2 = '0000000000003d9e7b063fa2c4d5';
const gmailReply: Case = {
  name: 'Gmail reply draft with In-Reply-To, folded References and Cc',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Thu, 24 Sep 2026 08:41:17 +0200',
      'References: <CAB7wQ2s1Yx0Lk9mZc3Vn8Rt6Ue4Pa2Hd5Gf7Jb1Kq0Xw@mail.gmail.com>',
      ' <CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>',
      'In-Reply-To: <CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>',
      'Message-ID: <CAJk3f9zR4t6Yu8Io0Pa2Sd4Fg6Hj8Kl0Zx2Cv4Bn6Mq@mail.gmail.com>',
      'Subject: Re: Offsite planning',
      'From: Sebastian Ko <seb@example.com>',
      'To: Ann Lee <ann@example.com>',
      'Cc: Bob Stone <bob@example.net>,',
      ' Carla Diaz <carla@example.org>',
      `Content-Type: multipart/alternative; boundary="${G2}"`,
      '',
      `--${G2}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Sounds good =E2=80=94 Thursday works for me.',
      '',
      'On Wed, Sep 23, 2026 at 4:02=E2=80=AFPM Ann Lee <ann@example.com> wrote:',
      '',
      '> Can we meet Thursday at 10?',
      '>',
      '',
      `--${G2}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<div dir=3D"ltr">Sounds good =E2=80=94 Thursday works for me.</div><br><div =',
      'class=3D"gmail_quote gmail_quote_container"><div dir=3D"ltr" class=3D"gmail=',
      '_attr">On Wed, Sep 23, 2026 at 4:02=E2=80=AFPM Ann Lee &lt;<a href=3D"mailt=',
      'o:ann@example.com">ann@example.com</a>&gt; wrote:<br></div><blockquote clas=',
      's=3D"gmail_quote" style=3D"margin:0px 0px 0px 0.8ex;border-left:1px solid r=',
      'gb(204,204,204);padding-left:1ex"><div dir=3D"ltr">Can we meet Thursday at =',
      '10?</div>',
      '</blockquote></div>',
      '',
      `--${G2}--`,
      '',
    ),
  ),
  boundary: G2,
  tree: [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ],
  body: '',
  attachments: [],
};

const G3 = '000000000000e7f1a2063fa3d5e6';
const G3A = '000000000000e7f1a1063fa3d5e6';
const gmailPastedImage: Case = {
  name: 'Gmail draft with an image pasted into the text (related > alternative + image)',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Thu, 24 Sep 2026 09:03:44 +0200',
      'Message-ID: <CAJk3f9-Wq1Er3Ty5Ui7Op9As1Df3Gh5Jk7Lz9Xc1Vb3N@mail.gmail.com>',
      'Subject: Chart for the deck',
      'From: Sebastian Ko <seb@example.com>',
      'To: design@example.com',
      `Content-Type: multipart/related; boundary="${G3}"`,
      '',
      `--${G3}`,
      `Content-Type: multipart/alternative; boundary="${G3A}"`,
      '',
      `--${G3A}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Here is the chart:',
      '[image: chart.png]',
      '',
      `--${G3A}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<div dir="ltr">Here is the chart:<div><img src="cid:ii_mfx1a2b30" alt="chart.png" width="542" height="301"><br></div></div>',
      '',
      `--${G3A}--`,
      `--${G3}`,
      'Content-Type: image/png; name="chart.png"',
      'Content-Disposition: inline; filename="chart.png"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <ii_mfx1a2b30>',
      'X-Attachment-Id: ii_mfx1a2b30',
      '',
      b64(PNG_CHART),
      `--${G3}--`,
      '',
    ),
  ),
  boundary: G3,
  tree: [
    ['', 'multipart/related'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'image/png'],
  ],
  body: '',
  attachments: [att('1', 'chart.png', 'image/png', PNG_CHART, true)],
};

const G4 = '000000000000a9b8c7063fa4e6f7';
const G4A = '000000000000a9b8c5063fa4e6f7';
/** Gmail's attachment headers: "; " then a folded name, RFC 2047 words inside the quotes, Content-ID and X-Attachment-Id. */
const G4_PDF_HEADERS = [
  'Content-Type: application/pdf; \r\n\tname="=?UTF-8?B?Q29udHJhdCBzaWduw6kgKHZlcnNpb24gZmluYWxlKSDigJQg?=\r\n\t=?UTF-8?B?w6l0w6kgMjAyNi5wZGY=?="',
  'Content-Disposition: attachment; \r\n\tfilename="=?UTF-8?B?Q29udHJhdCBzaWduw6kgKHZlcnNpb24gZmluYWxlKSDigJQg?=\r\n\t=?UTF-8?B?w6l0w6kgMjAyNi5wZGY=?="',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <f_mfx2c3d41>',
  'X-Attachment-Id: f_mfx2c3d41',
];
const gmailAttachments: Case = {
  name: 'Gmail draft with two attachments added in the UI (RFC 2047 filename split over two words)',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Thu, 24 Sep 2026 11:20:05 +0200',
      'Message-ID: <CAJk3f9yUi8Op0As2Df4Gh6Jk8Lz0Xc2Vb4Nm6Qw8Er0T@mail.gmail.com>',
      'Subject: =?UTF-8?Q?Contrat_sign=C3=A9_et_annexes?=',
      'From: Sebastian Ko <seb@example.com>',
      'To: legal@example.com',
      `Content-Type: multipart/mixed; boundary="${G4}"`,
      '',
      `--${G4}`,
      `Content-Type: multipart/alternative; boundary="${G4A}"`,
      '',
      `--${G4A}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Please find both files attached.',
      '',
      `--${G4A}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<div dir="ltr">Please find both files attached.</div>',
      '',
      `--${G4A}--`,
      `--${G4}`,
      ...G4_PDF_HEADERS,
      '',
      b64(PDF_CONTRACT),
      `--${G4}`,
      `Content-Type: ${DOCX}; `,
      '\tname="Annexe A.docx"',
      'Content-Disposition: attachment; filename="Annexe A.docx"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <f_mfx2c3d52>',
      'X-Attachment-Id: f_mfx2c3d52',
      '',
      b64(DOCX_ANNEX),
      `--${G4}--`,
      '',
    ),
  ),
  boundary: G4,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'application/pdf'],
    ['2', DOCX],
  ],
  body: '0',
  attachments: [att('1', 'Contrat signé (version finale) — été 2026.pdf', 'application/pdf', PDF_CONTRACT), att('2', 'Annexe A.docx', DOCX, DOCX_ANNEX)],
};

const G5 = '0000000000007f6e5d063fa6a1b2';
const G5R = '0000000000007f6e5c063fa6a1b2';
const G5A = '0000000000007f6e5b063fa6a1b2';
const gmailImageAndAttachment: Case = {
  name: 'Gmail draft from a send-as alias with a pasted image and an attachment (mixed > related > alternative)',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Thu, 24 Sep 2026 12:05:40 +0200',
      'Message-ID: <CAJk3f9_Tg5Hy7Uj9Ik1Ol3Pm5Nb7Vc9Xz1As3Dq5Fw7E@mail.gmail.com>',
      'Subject: Your invoice and our new logo',
      'From: Example Support <support@example.com>',
      'To: client@example.org',
      `Content-Type: multipart/mixed; boundary="${G5}"`,
      '',
      `--${G5}`,
      `Content-Type: multipart/related; boundary="${G5R}"`,
      '',
      `--${G5R}`,
      `Content-Type: multipart/alternative; boundary="${G5A}"`,
      '',
      `--${G5A}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Invoice attached. Our new logo:',
      '[image: logo.png]',
      '',
      `--${G5A}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<div dir="ltr">Invoice attached. Our new logo:<div><img src="cid:ii_mfy7q1w20" alt="logo.png" width="200" height="80"><br></div></div>',
      '',
      `--${G5A}--`,
      `--${G5R}`,
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <ii_mfy7q1w20>',
      'X-Attachment-Id: ii_mfy7q1w20',
      '',
      b64(PNG_LOGO),
      `--${G5R}--`,
      `--${G5}`,
      'Content-Type: application/pdf; name="Invoice 1042.pdf"',
      'Content-Disposition: attachment; filename="Invoice 1042.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <f_mfy7q1w31>',
      'X-Attachment-Id: f_mfy7q1w31',
      '',
      b64(PDF_INVOICE),
      `--${G5}--`,
      '',
    ),
  ),
  boundary: G5,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/related'],
    ['0.0', 'multipart/alternative'],
    ['0.0.0', 'text/plain'],
    ['0.0.1', 'text/html'],
    ['0.1', 'image/png'],
    ['1', 'application/pdf'],
  ],
  body: '0',
  attachments: [att('0.1', 'logo.png', 'image/png', PNG_LOGO, true), att('1', 'Invoice 1042.pdf', 'application/pdf', PDF_INVOICE)],
};

/** The forwarded message: a complete multipart message of its own, ending with CRLF. */
const FORWARDED = crlf(
  'Return-Path: <billing@vendor.example>',
  'Received: from mail.vendor.example (mail.vendor.example. [203.0.113.7])',
  '        by mx.google.com with ESMTPS id a1b2c3d4e5f6',
  '        for <seb@example.com>; Mon, 21 Sep 2026 09:00:00 -0700 (PDT)',
  'From: Vendor Billing <billing@vendor.example>',
  'To: seb@example.com',
  'Subject: Invoice 1042',
  'Date: Mon, 21 Sep 2026 16:00:00 +0000',
  'Message-ID: <inv-1042@vendor.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="vendor-alt-7731"',
  '',
  '--vendor-alt-7731',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Invoice 1042: 250.00 EUR due 2026-10-21.',
  '--vendor-alt-7731',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Invoice 1042: <b>250.00 EUR</b> due 2026-10-21.</p>',
  '--vendor-alt-7731--',
  '',
);
const G6 = '000000000000c3d4e5063fa7b2c3';
const G6A = '000000000000c3d4e4063fa7b2c3';
const gmailForward: Case = {
  name: 'Gmail draft forwarding a message as an attachment (message/rfc822)',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Thu, 24 Sep 2026 12:40:19 +0200',
      'Message-ID: <CAJk3f9sDf5Gh7Jk9Lz1Xc3Vb5Nm7Qw9Er1Ty3Ui5Op7A@mail.gmail.com>',
      'Subject: Fwd: Invoice 1042',
      'From: Sebastian Ko <seb@example.com>',
      'To: accounting@example.com',
      `Content-Type: multipart/mixed; boundary="${G6}"`,
      '',
      `--${G6}`,
      `Content-Type: multipart/alternative; boundary="${G6A}"`,
      '',
      `--${G6A}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Forwarding the invoice as an attachment.',
      '',
      `--${G6A}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<div dir="ltr">Forwarding the invoice as an attachment.</div>',
      '',
      `--${G6A}--`,
      `--${G6}`,
      'Content-Type: message/rfc822; name="Invoice 1042.eml"',
      'Content-Disposition: attachment; filename="Invoice 1042.eml"',
      '',
      FORWARDED,
      `--${G6}--`,
      '',
    ),
  ),
  boundary: G6,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'message/rfc822'],
  ],
  body: '0',
  // Not base64: the size is the raw length of the body.
  attachments: [att('1', 'Invoice 1042.eml', 'message/rfc822', Buffer.byteLength(FORWARDED))],
};

const G7 = '0000000000001a2b3c063fa8c3d4';
const G7A = '0000000000001a2b3a063fa8c3d4';
const gmailEmptyBody: Case = {
  name: 'Gmail draft that is only an attachment (empty text and HTML)',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Thu, 24 Sep 2026 13:37:00 +0200',
      'Message-ID: <CAJk3f9wPo9Iu7Yt5Re3Wq1Sa2Df4Gh6Jk8Lm0Nb2Vc4X@mail.gmail.com>',
      'Subject: Slides',
      'From: Sebastian Ko <seb@example.com>',
      'To: team@example.com',
      `Content-Type: multipart/mixed; boundary="${G7}"`,
      '',
      `--${G7}`,
      `Content-Type: multipart/alternative; boundary="${G7A}"`,
      '',
      `--${G7A}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      '',
      '',
      `--${G7A}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<div dir="ltr"><br></div>',
      '',
      `--${G7A}--`,
      `--${G7}`,
      'Content-Type: application/pdf; name="slides.pdf"',
      'Content-Disposition: attachment; filename="slides.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <f_mfz0a1b20>',
      'X-Attachment-Id: f_mfz0a1b20',
      '',
      b64(PDF_SLIDES),
      `--${G7}--`,
      '',
    ),
  ),
  boundary: G7,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'application/pdf'],
  ],
  body: '0',
  attachments: [att('1', 'slides.pdf', 'application/pdf', PDF_SLIDES)],
};

const IPHONE = 'Apple-Mail-5E2F1A0B-3C4D-4E5F-8A9B-0C1D2E3F4A5B';
const iphonePhoto: Case = {
  name: 'iPhone Mail with a photo between two text parts (unquoted boundary, blank preamble)',
  raw: bytes(
    crlf(
      `Content-Type: multipart/mixed; boundary=${IPHONE}`,
      'Content-Transfer-Encoding: 7bit',
      'From: Jordan Park <jordan@example.org>',
      'Mime-Version: 1.0 (1.0)',
      'Date: Wed, 23 Sep 2026 18:44:09 -0700',
      'Subject: Photo from the site visit',
      'Message-Id: <6B1D2F3A-8C9E-4A0B-9D1C-2E3F4A5B6C7D@example.org>',
      'To: Sebastian Ko <seb@example.com>',
      'X-Mailer: iPhone Mail (22A3354)',
      '',
      '',
      `--${IPHONE}`,
      'Content-Type: text/plain;',
      '\tcharset=us-ascii',
      'Content-Transfer-Encoding: 7bit',
      '',
      "Here's the photo from today",
      '',
      `--${IPHONE}`,
      'Content-Type: image/jpeg;',
      '\tname=IMG_4821.jpeg;',
      '\tx-apple-part-url=6E5D4C3B-2A19-4807-B6F5-E4D3C2B1A098',
      'Content-Disposition: inline;',
      '\tfilename=IMG_4821.jpeg',
      'Content-Transfer-Encoding: base64',
      '',
      b64(JPEG_PHOTO),
      `--${IPHONE}`,
      'Content-Type: text/plain;',
      '\tcharset=us-ascii',
      'Content-Transfer-Encoding: 7bit',
      '',
      '',
      '',
      '',
      'Sent from my iPhone',
      `--${IPHONE}--`,
      '',
    ),
  ),
  boundary: IPHONE,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'image/jpeg'],
    ['2', 'text/plain'],
  ],
  body: '0',
  // spec reading: the trailing "Sent from my iPhone" text/plain part (no filename, no
  // attachment disposition) is text, not a file, so listAttachments leaves it out.
  attachments: [att('1', 'IMG_4821.jpeg', 'image/jpeg', JPEG_PHOTO, true)],
};

const applePlain: Case = {
  name: 'Apple Mail plain text (Content-Type first, Mime-Version with a comment, no final line break)',
  raw: bytes(
    crlf(
      'Content-Type: text/plain;',
      '\tcharset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      'Mime-Version: 1.0 (Mac OS X Mail 16.0 \\(3826.200.121\\))',
      'Subject: Lunch on Friday?',
      'Message-Id: <A1B2C3D4-E5F6-4789-9ABC-DEF012345678@example.org>',
      'Date: Wed, 23 Sep 2026 12:30:00 -0700',
      'To: Sebastian Ko <seb@example.com>',
      'From: Jordan Park <jordan@example.org>',
      'X-Mailer: Apple Mail (2.3826.200.121)',
      '',
      'Hi Sebastian,',
      '',
      'Are you free for lunch on Friday? The new caf=C3=A9 on 3rd opened this =',
      'week.',
      '',
      'Jordan',
    ),
  ),
  tree: [['', 'text/plain']],
  body: '',
  attachments: [],
};

const APPLE_ALT = 'Apple-Mail=_0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const APPLE_REL = 'Apple-Mail=_9A8B7C6D-5E4F-3A2B-1C0D-E9F8A7B6C5D4';
const appleHtmlImage: Case = {
  name: 'Apple Mail HTML with an inline image (alternative > related, the reverse of Gmail)',
  raw: bytes(
    crlf(
      'From: Jordan Park <jordan@example.org>',
      'Content-Type: multipart/alternative;',
      `\tboundary="${APPLE_ALT}"`,
      'Mime-Version: 1.0 (Mac OS X Mail 16.0 \\(3826.200.121\\))',
      'Subject: Floor plan',
      'Date: Wed, 23 Sep 2026 15:10:27 -0700',
      'Message-Id: <0C9B8A7F-6E5D-4C3B-2A19-0807F6E5D4C3@example.org>',
      'To: Sebastian Ko <seb@example.com>',
      'X-Mailer: Apple Mail (2.3826.200.121)',
      '',
      '',
      `--${APPLE_ALT}`,
      'Content-Transfer-Encoding: 7bit',
      'Content-Type: text/plain;',
      '\tcharset=us-ascii',
      '',
      'Updated floor plan below.',
      '',
      '',
      `--${APPLE_ALT}`,
      'Content-Type: multipart/related;',
      '\ttype="text/html";',
      `\tboundary="${APPLE_REL}"`,
      '',
      '',
      `--${APPLE_REL}`,
      'Content-Transfer-Encoding: 7bit',
      'Content-Type: text/html;',
      '\tcharset=us-ascii',
      '',
      '<html><head><meta http-equiv="content-type" content="text/html; charset=us-ascii"></head><body style="overflow-wrap: break-word; -webkit-nbsp-mode: space; line-break: after-white-space;">Updated floor plan below.<div><br></div><div><img apple-inline="yes" id="4E3D2C1B-0A9F-4E8D-7C6B-5A4F3E2D1C0B" src="cid:5C1F0E2D-3B4A-4C5D-9E6F-7A8B9C0D1E2F"></div></body></html>',
      `--${APPLE_REL}`,
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: inline;',
      '\tfilename=floorplan.png',
      'Content-Type: image/png;',
      '\tx-unix-mode=0644;',
      '\tname="floorplan.png"',
      'Content-Id: <5C1F0E2D-3B4A-4C5D-9E6F-7A8B9C0D1E2F>',
      '',
      b64(PNG_FLOORPLAN),
      `--${APPLE_REL}--`,
      '',
      `--${APPLE_ALT}--`,
      '',
    ),
  ),
  boundary: APPLE_ALT,
  tree: [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'multipart/related'],
    ['1.0', 'text/html'],
    ['1.1', 'image/png'],
  ],
  body: '',
  attachments: [att('1.1', 'floorplan.png', 'image/png', PNG_FLOORPLAN, true)],
};

const TB1 = '------------a1B2c3D4e5F6g7H8i9J0k1L2';
const thunderbirdAttachment: Case = {
  name: 'Thunderbird: preamble, 8-bit format=flowed text with a "-- " signature, RFC 2231 continued filename',
  raw: bytes(
    crlf(
      `Content-Type: multipart/mixed; boundary="${TB1}"`,
      'Message-ID: <7c1e3a52-9f0b-4d6e-8a21-5b3c4d2e1f00@example.net>',
      'Date: Thu, 24 Sep 2026 07:55:31 +0300',
      'MIME-Version: 1.0',
      'User-Agent: Mozilla Thunderbird',
      'Content-Language: ru',
      'To: Sebastian Ko <seb@example.com>',
      'From: =?UTF-8?B?0JzQsNGA0LjRjyDQmNCy0LDQvdC+0LLQsA==?= <maria@example.net>',
      'Subject: =?UTF-8?B?0J7RgtGH0ZHRgiDQt9CwINGB0LXQvdGC0Y/QsdGA0Yw=?=',
      '',
      'This is a multi-part message in MIME format.',
      `--${TB1}`,
      'Content-Type: text/plain; charset=UTF-8; format=flowed',
      'Content-Transfer-Encoding: 8bit',
      '',
      'Добрый день!',
      '',
      'Отчёт во вложении. ',
      'Цифры за сентябрь окончательные.',
      '',
      '-- ',
      'Мария',
      '',
      `--${TB1}`,
      'Content-Type: application/pdf; name="=?UTF-8?B?0J7RgtGH0ZHRgiDQt9CwINGB0LXQvdGC0Y/QsdGA0Ywg?=',
      ' =?UTF-8?B?MjAyNi5wZGY=?="',
      'Content-Disposition: attachment;',
      " filename*0*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82%20%D0%B7%D0%B0%20%D1%81;",
      ' filename*1*=%D0%B5%D0%BD%D1%82%D1%8F%D0%B1%D1%80%D1%8C%202026.pdf',
      'Content-Transfer-Encoding: base64',
      '',
      b64(PDF_REPORT, 72),
      '',
      `--${TB1}--`,
      '',
    ),
  ),
  boundary: TB1,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
  ],
  body: '0',
  attachments: [att('1', 'Отчёт за сентябрь 2026.pdf', 'application/pdf', PDF_REPORT)],
};

const TB2M = '------------0rVbXn2Ha8Sd4Jf6Kg1Lq3Zw';
const TB2A = '------------7yTe5Wq3Ru1Io9Pa8Sd6Fg4H';
const TB2R = '------------Jk2Lm4Nb6Vc8Xz0Qw1Er3Ty5';
const thunderbirdHtml: Case = {
  name: 'Thunderbird HTML with an embedded image and a CSV attachment (mixed > alternative > related)',
  raw: bytes(
    crlf(
      'Message-ID: <3f9d2c1b-7a6e-4d5c-8b4a-2e1f0d9c8b7a@example.net>',
      'Date: Thu, 24 Sep 2026 10:22:48 +0200',
      'MIME-Version: 1.0',
      'User-Agent: Mozilla Thunderbird',
      'Content-Language: en-US',
      'To: Sebastian Ko <seb@example.com>',
      'From: Piotr Nowak <piotr@example.net>',
      'Subject: Q3 data',
      'Content-Type: multipart/mixed;',
      ` boundary="${TB2M}"`,
      '',
      'This is a multi-part message in MIME format.',
      `--${TB2M}`,
      'Content-Type: multipart/alternative;',
      ` boundary="${TB2A}"`,
      '',
      `--${TB2A}`,
      'Content-Type: text/plain; charset=UTF-8; format=flowed',
      'Content-Transfer-Encoding: 7bit',
      '',
      'Q3 data attached; chart below.',
      '',
      `--${TB2A}`,
      'Content-Type: multipart/related;',
      ` boundary="${TB2R}"`,
      '',
      `--${TB2R}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      '<!DOCTYPE html>',
      '<html>',
      '  <head>',
      '    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">',
      '  </head>',
      '  <body>',
      '    <p>Q3 data attached; chart below.</p>',
      '    <p><img src="cid:part1.3Kx9Lm2P.8Qw4Er6T@example.net" alt=""></p>',
      '  </body>',
      '</html>',
      `--${TB2R}`,
      'Content-Type: image/png; name="chart.png"',
      'Content-Disposition: inline; filename="chart.png"',
      'Content-Id: <part1.3Kx9Lm2P.8Qw4Er6T@example.net>',
      'Content-Transfer-Encoding: base64',
      '',
      b64(PNG_TB_CHART, 72),
      '',
      `--${TB2R}--`,
      '',
      `--${TB2A}--`,
      `--${TB2M}`,
      'Content-Type: text/csv; charset=UTF-8; name="Q3 data.csv"',
      'Content-Disposition: attachment; filename="Q3 data.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(CSV_Q3, 72),
      '',
      `--${TB2M}--`,
      '',
    ),
  ),
  boundary: TB2M,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'multipart/related'],
    ['0.1.0', 'text/html'],
    ['0.1.1', 'image/png'],
    ['1', 'text/csv'],
  ],
  body: '0',
  attachments: [att('0.1.1', 'chart.png', 'image/png', PNG_TB_CHART, true), att('1', 'Q3 data.csv', 'text/csv', CSV_Q3)],
};

const OUTLOOK_TEXT = bytes('Hi Sebastian,\r\n\r\nattached is the revised contract; the changes are marked.\r\n\r\nBest regards,\r\nAnn\r\n');
const OUTLOOK_HTML = bytes(
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body lang="EN-US"><div class="WordSection1"><p class="MsoNormal">Hi Sebastian,</p><p class="MsoNormal">attached is the revised contract; the changes are marked.</p><p class="MsoNormal">Best regards,<br>Ann</p><p class="MsoNormal"><img width="120" height="40" src="cid:image001.png@01DD2C8E.5A1B3C40"></p></div></body></html>',
);
const OL_MIX = '_004_DM6PR11MB46581A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7DM6PR11MB4658namp_';
const OL_REL = '_005_DM6PR11MB46581A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7DM6PR11MB4658namp_';
const OL_ALT = '_000_DM6PR11MB46581A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7DM6PR11MB4658namp_';
const outlookExchange: Case = {
  name: 'Outlook / Exchange reply: tab folds, empty header, signature image, RFC 2231 filename with size and dates',
  raw: bytes(
    crlf(
      'From: "Lee, Ann" <ann.lee@contoso.example>',
      'To: Sebastian Ko <seb@example.com>',
      'CC: Legal Team <legal@contoso.example>',
      'Subject: RE: Contract draft',
      'Thread-Topic: Contract draft',
      'Thread-Index: AQHZ3k2xYk4v1ZC0SkKX7m9q0nYyLbA2UgAAb3c=',
      'Date: Wed, 23 Sep 2026 14:02:11 +0000',
      'Message-ID:',
      '\t<DM6PR11MB46581A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7@DM6PR11MB4658.namprd11.prod.outlook.com>',
      'References: <CAJk3f9xQm7p2Lr8Vd5n1Wb0YtE6uHc4sZa9gKo3iN2fPq@mail.gmail.com>',
      'In-Reply-To: <CAJk3f9xQm7p2Lr8Vd5n1Wb0YtE6uHc4sZa9gKo3iN2fPq@mail.gmail.com>',
      'Accept-Language: en-US',
      'Content-Language: en-US',
      'X-MS-Has-Attach: yes',
      'X-MS-TNEF-Correlator:',
      'Content-Type: multipart/mixed;',
      `\tboundary="${OL_MIX}"`,
      'MIME-Version: 1.0',
      '',
      `--${OL_MIX}`,
      'Content-Type: multipart/related;',
      `\tboundary="${OL_REL}";`,
      '\ttype="multipart/alternative"',
      '',
      `--${OL_REL}`,
      'Content-Type: multipart/alternative;',
      `\tboundary="${OL_ALT}"`,
      '',
      `--${OL_ALT}`,
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(OUTLOOK_TEXT),
      '',
      `--${OL_ALT}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(OUTLOOK_HTML),
      '',
      `--${OL_ALT}--`,
      '',
      `--${OL_REL}`,
      'Content-Type: image/png; name="image001.png"',
      'Content-Description: image001.png',
      `Content-Disposition: inline; filename="image001.png"; size=${PNG_SIGNATURE.length};`,
      '\tcreation-date="Wed, 23 Sep 2026 14:02:10 GMT";',
      '\tmodification-date="Wed, 23 Sep 2026 14:02:10 GMT"',
      'Content-ID: <image001.png@01DD2C8E.5A1B3C40>',
      'Content-Transfer-Encoding: base64',
      '',
      b64(PNG_SIGNATURE),
      '',
      `--${OL_REL}--`,
      '',
      `--${OL_MIX}`,
      `Content-Type: ${DOCX};`,
      '\tname="=?utf-8?B?VmVydHJhZyDDvGJlcmFyYmVpdGV0LmRvY3g=?="',
      'Content-Description: =?utf-8?B?VmVydHJhZyDDvGJlcmFyYmVpdGV0LmRvY3g=?=',
      'Content-Disposition: attachment;',
      `\tfilename*=utf-8''Vertrag%20%C3%BCberarbeitet.docx; size=${DOCX_CONTRACT.length};`,
      '\tcreation-date="Wed, 23 Sep 2026 14:01:58 GMT";',
      '\tmodification-date="Wed, 23 Sep 2026 14:02:10 GMT"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(DOCX_CONTRACT),
      '',
      `--${OL_MIX}--`,
      '',
    ),
  ),
  boundary: OL_MIX,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/related'],
    ['0.0', 'multipart/alternative'],
    ['0.0.0', 'text/plain'],
    ['0.0.1', 'text/html'],
    ['0.1', 'image/png'],
    ['1', DOCX],
  ],
  body: '0',
  attachments: [att('0.1', 'image001.png', 'image/png', PNG_SIGNATURE, true), att('1', 'Vertrag überarbeitet.docx', DOCX, DOCX_CONTRACT)],
};

const OLD_MIX = '----=_NextPart_000_0001_01DA2B3C.4D5E6F70';
const OLD_ALT = '----=_NextPart_001_0002_01DA2B3C.4D5E6F70';
const outlookClassic: Case = {
  name: 'Classic Outlook: preamble, ----=_NextPart boundaries, quoted-printable Latin-1, Q-encoded filename, upper-case type',
  raw: bytes(
    crlf(
      'From: "Hans Meier" <hans.meier@example.de>',
      'To: <seb@example.com>',
      'Subject: Lebenslauf',
      'Date: Tue, 22 Sep 2026 16:45:10 +0200',
      'Message-ID: <000001da2b3c$4d5e6f70$e81b4d50$@example.de>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed;',
      `\tboundary="${OLD_MIX}"`,
      'X-Mailer: Microsoft Outlook 16.0',
      'Thread-Index: AdorPE1ecHDoG01QRkS2bXJmZ0tU8g==',
      'Content-Language: de',
      '',
      'This is a multipart message in MIME format.',
      '',
      `--${OLD_MIX}`,
      'Content-Type: multipart/alternative;',
      `\tboundary="${OLD_ALT}"`,
      '',
      '',
      `--${OLD_ALT}`,
      'Content-Type: text/plain;',
      '\tcharset="iso-8859-1"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Guten Tag,',
      '',
      'anbei mein Lebenslauf f=FCr die ausgeschriebene Stelle.',
      '',
      'Mit freundlichen Gr=FC=DFen',
      'Hans Meier',
      '',
      '',
      `--${OLD_ALT}`,
      'Content-Type: text/html;',
      '\tcharset="iso-8859-1"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<html xmlns:v=3D"urn:schemas-microsoft-com:vml" =',
      'xmlns:o=3D"urn:schemas-microsoft-com:office:office" =',
      'xmlns:w=3D"urn:schemas-microsoft-com:office:word" =',
      'xmlns=3D"http://www.w3.org/TR/REC-html40"><head><meta =',
      'http-equiv=3DContent-Type content=3D"text/html; =',
      'charset=3Diso-8859-1"></head><body lang=3DDE><div =',
      'class=3DWordSection1><p class=3DMsoNormal>Guten Tag,<o:p></o:p></p><p =',
      'class=3DMsoNormal>anbei mein Lebenslauf f=FCr die ausgeschriebene =',
      'Stelle.<o:p></o:p></p></div></body></html>',
      '',
      `--${OLD_ALT}--`,
      '',
      `--${OLD_MIX}`,
      'Content-Type: application/PDF;',
      '\tname="=?iso-8859-1?Q?Lebenslauf_M=FCller-Meier_2026.pdf?="',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment;',
      '\tfilename="=?iso-8859-1?Q?Lebenslauf_M=FCller-Meier_2026.pdf?="',
      '',
      b64(PDF_CV),
      '',
      `--${OLD_MIX}--`,
      '',
      '',
    ),
  ),
  boundary: OLD_MIX,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'application/pdf'],
  ],
  body: '0',
  attachments: [att('1', 'Lebenslauf Müller-Meier 2026.pdf', 'application/pdf', PDF_CV)],
};

const rfc2046Sample: Case = {
  name: 'RFC 2046 5.1.1 sample: boundary with a space, preamble, epilogue, a part without header fields',
  raw: bytes(
    crlf(
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
    ),
  ),
  boundary: 'simple boundary',
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'text/plain'],
  ],
  body: '0',
  attachments: [],
};

const SERVER_LOG = crlf('02:14:07 worker-3 OOM killed', '02:14:09 worker-3 restarted', '');
const muttLf: Case = {
  name: 'mutt with LF-only line endings and a text attachment',
  raw: bytes(
    lf(
      'Date: Thu, 24 Sep 2026 06:12:40 +0000',
      'From: Dana Kowalski <dana@example.org>',
      'To: seb@example.com',
      'Subject: Logs from last night',
      'Message-ID: <20260924061240.GA12345@example.org>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="h3KxY8p2Qw7ZbN0a"',
      'Content-Disposition: inline',
      'User-Agent: Mutt/2.2.12 (2023-09-09)',
      '',
      '',
      '--h3KxY8p2Qw7ZbN0a',
      'Content-Type: text/plain; charset=us-ascii',
      'Content-Disposition: inline',
      '',
      'Logs attached, the interesting part starts at 02:14.',
      '',
      '-- ',
      'Dana',
      '',
      '--h3KxY8p2Qw7ZbN0a',
      'Content-Type: text/plain; charset=us-ascii',
      'Content-Disposition: attachment; filename="server.log"',
      '',
      '02:14:07 worker-3 OOM killed',
      '02:14:09 worker-3 restarted',
      '',
      '--h3KxY8p2Qw7ZbN0a--',
      '',
    ),
  ),
  boundary: 'h3KxY8p2Qw7ZbN0a',
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'text/plain'],
  ],
  body: '0',
  // spec reading: "raw length" of a non-base64 body is measured after CRLF normalisation.
  attachments: [att('1', 'server.log', 'text/plain', Buffer.byteLength(SERVER_LOG))],
};

const TRUNC = '000000000000f1e2d3063fa9d4e5';
const truncated: Case = {
  name: 'Gmail-style message cut off before its close delimiter',
  raw: bytes(
    crlf(
      'MIME-Version: 1.0',
      'Date: Thu, 24 Sep 2026 14:00:00 +0200',
      'Message-ID: <CAJk3f9vTr4Ew2Qa1Zs3Xd5Cf7Vg9Bh1Nj3Mk5Lo7Pi9U@mail.gmail.com>',
      'Subject: Cut off',
      'From: Sebastian Ko <seb@example.com>',
      'To: ann@example.com',
      `Content-Type: multipart/mixed; boundary="${TRUNC}"`,
      '',
      `--${TRUNC}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'The attachment is below.',
      '',
      `--${TRUNC}`,
      'Content-Type: application/pdf; name="cut.pdf"',
      'Content-Disposition: attachment; filename="cut.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(PDF_CUT),
      '',
    ),
  ),
  boundary: TRUNC,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
  ],
  body: '0',
  attachments: [att('1', 'cut.pdf', 'application/pdf', PDF_CUT)],
  exact: false,
};

const scannerPdf: Case = {
  name: 'Scan-to-mail: the whole message is one PDF with an attachment disposition',
  raw: bytes(
    crlf(
      'Return-Path: <scanner@office.example>',
      'From: "Office Scanner" <scanner@office.example>',
      'To: seb@example.com',
      'Subject: Scanned document from MFP-3F',
      'Date: Thu, 24 Sep 2026 08:00:12 +0200',
      'Message-Id: <1727157612.4821@mfp-3f.office.example>',
      'MIME-Version: 1.0',
      'Content-Type: application/pdf; name="scan_20260924_080012.pdf"',
      'Content-Disposition: attachment; filename="scan_20260924_080012.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(PDF_SCAN),
      '',
    ),
  ),
  tree: [['', 'application/pdf']],
  // spec reading: bodyEntity is "the message itself unless it is multipart/mixed", even
  // when the message is nothing but an attachment; listAttachments still lists it (id '').
  body: '',
  attachments: [att('', 'scan_20260924_080012.pdf', 'application/pdf', PDF_SCAN)],
  // Taken literally, replaceBody would swap the PDF's Content-* fields for the text's and
  // lose the PDF; that is not something a test should pin down. The chain addParts ->
  // replaceBody, which is well defined, is tested separately.
  skipReplaceBody: true,
};

const utf8Headers: Case = {
  name: 'SMTPUTF8 message: raw 8-bit UTF-8 in From and Subject, 8bit body',
  raw: bytes(
    crlf(
      'From: Zoë Müller <zoe@example.ch>',
      'To: Sebastian Ko <seb@example.com>',
      "Subject: Réunion d'équipe, voilà",
      'Date: Thu, 24 Sep 2026 10:00:00 +0200',
      'Message-ID: <20260924100000.utf8@example.ch>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      'Bonjour à tous,',
      '',
      'la réunion est déplacée à jeudi.',
      '',
      'Zoë',
      '',
    ),
  ),
  tree: [['', 'text/plain']],
  body: '',
  attachments: [],
};

const PY = '===============5829164730258710937==';
const pythonEmail: Case = {
  name: "Python email package: '=' boundary, per-part MIME-Version, quoted filename with escapes and parentheses",
  raw: bytes(
    crlf(
      `Content-Type: multipart/mixed; boundary="${PY}"`,
      'MIME-Version: 1.0',
      'Subject: Nightly export',
      'From: reports@example.com',
      'To: seb@example.com',
      'Date: Thu, 24 Sep 2026 02:00:03 -0000',
      '',
      `--${PY}`,
      'Content-Type: text/plain; charset="us-ascii"',
      'MIME-Version: 1.0',
      'Content-Transfer-Encoding: 7bit',
      '',
      'Nightly export attached.',
      '',
      `--${PY}`,
      'Content-Type: text/csv',
      'MIME-Version: 1.0',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="budget \\"v2\\" (final).csv"',
      '',
      b64(CSV_EXPORT),
      '',
      `--${PY}--`,
      '',
    ),
  ),
  boundary: PY,
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'text/csv'],
  ],
  body: '0',
  attachments: [att('1', 'budget "v2" (final).csv', 'text/csv', CSV_EXPORT)],
};

const cronPlain: Case = {
  name: 'Cron mail without any MIME header fields, two Received fields',
  raw: bytes(
    crlf(
      'Return-Path: <root@build.example.com>',
      'Received: by build.example.com (Postfix, from userid 0)',
      '\tid 4F1A22C0E1; Thu, 24 Sep 2026 03:00:01 +0000 (UTC)',
      'Received: from build.example.com (localhost [127.0.0.1])',
      '\tby build.example.com (Postfix) with ESMTP id 4F1A22C0E0',
      '\tfor <seb@example.com>; Thu, 24 Sep 2026 03:00:00 +0000 (UTC)',
      'From: root@build.example.com (Cron Daemon)',
      'To: seb@example.com',
      'Subject: Cron <root@build> /usr/local/bin/backup.sh',
      'Date: Thu, 24 Sep 2026 03:00:01 +0000 (UTC)',
      'Message-Id: <20260924030001.4F1A22C0E1@build.example.com>',
      '',
      'backup completed: 14 files, 2.3 GB',
      '',
    ),
  ),
  tree: [['', 'text/plain']],
  body: '',
  attachments: [],
};

/** A draft this connector created itself (random boundaries, RFC 2231 filename next to an ASCII fallback). */
const connectorText = buildMimeMessage({
  from: 'Sebastian Ko <seb@example.com>',
  to: ['Ann Lee <ann@example.com>'],
  cc: ['bob@example.net'],
  subject: 'Überblick Q3',
  text: 'Hi Ann,\n\nthe overview and a photo are attached.',
  html: '<p>Hi Ann,</p><p>the overview and a photo are attached.</p>',
  inReplyTo: '<CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>',
  references: '<CAB7wQ2s1Yx0Lk9mZc3Vn8Rt6Ue4Pa2Hd5Gf7Jb1Kq0Xw@mail.gmail.com> <CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>',
  attachments: [
    { filename: 'Überblick Q3.pdf', mimeType: 'application/pdf', content: PDF_OVERVIEW },
    { filename: 'photo.jpg', mimeType: 'image/jpeg', content: JPEG_SMALL },
  ],
  date: new Date(Date.UTC(2026, 8, 24, 9, 30, 0)),
});
const connectorBuilt: Case = {
  name: 'Draft built by this connector (buildMimeMessage) with HTML and two attachments',
  raw: bytes(connectorText),
  boundary: /boundary="([^"]+)"/.exec(connectorText)?.[1] ?? '',
  tree: [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'application/pdf'],
    ['2', 'image/jpeg'],
  ],
  body: '0',
  // spec reading: an RFC 2231 filename*= wins over the plain ASCII fallback filename="_berblick Q3.pdf".
  attachments: [att('1', 'Überblick Q3.pdf', 'application/pdf', PDF_OVERVIEW), att('2', 'photo.jpg', 'image/jpeg', JPEG_SMALL)],
};

const CORPUS: Case[] = [
  gmailAlternative,
  gmailReply,
  gmailPastedImage,
  gmailAttachments,
  gmailImageAndAttachment,
  gmailForward,
  gmailEmptyBody,
  iphonePhoto,
  applePlain,
  appleHtmlImage,
  thunderbirdAttachment,
  thunderbirdHtml,
  outlookExchange,
  outlookClassic,
  rfc2046Sample,
  muttLf,
  truncated,
  scannerPdf,
  utf8Headers,
  pythonEmail,
  cronPlain,
  connectorBuilt,
];

/** The corpus message as the parser sees it: CRLF line breaks, one latin1 character per byte. */
const textOf = (c: Case) => normalize(c.raw.toString('latin1'));

const isMixed = (c: Case) => c.tree[0]![1] === 'multipart/mixed';

/**
 * Checks the result of removing top-level parts from a message. A
 * multipart/mixed left with a single part "may stay as it is": when it stays,
 * the bytes must be exactly the original minus the removed parts; when the
 * implementation collapses it instead, the remaining part must have moved up
 * with every other header field untouched.
 */
function assertTopLevelRemoval(msg: MimeEntity, c: Case, expectedText: string, expectedTree: Tree, expectedAttachments: Attachment[]): void {
  const collapsed = isMixed(c) && msg.type !== 'multipart/mixed';
  if (!collapsed) {
    assert.equal(serialize(msg), expectedText);
    assert.deepEqual(tree(msg), expectedTree);
    assert.deepEqual(tree(reparse(expectedText)), expectedTree);
    assert.deepEqual(attachmentsOf(msg), expectedAttachments);
    return;
  }
  const topLevel = expectedTree.filter(([id]) => /^\d+$/.test(id));
  assert.equal(topLevel.length, 1, 'only a multipart/mixed left with a single part may collapse');
  const hoist = (id: string) => (id === '0' ? '' : id.slice(2));
  const hoisted = expectedTree.filter(([id]) => id !== '').map(([id, type]): [string, string] => [hoist(id), type]);
  assert.deepEqual(tree(msg), hoisted);
  assert.deepEqual(otherFields(msg.headers), otherFields(splitHead(textOf(c)).fields));
  assert.deepEqual(
    attachmentsOf(msg),
    expectedAttachments.map((a) => ({ ...a, partId: hoist(a.partId) })),
  );
  assert.deepEqual(tree(reparse(serialize(msg))), hoisted);
}

// ---------------------------------------------------------------------------
// Generic checks over the whole corpus
// ---------------------------------------------------------------------------

test('corpus: every message is present and the connector-built draft has a boundary', () => {
  assert.ok(CORPUS.length >= 15);
  assert.equal(new Set(CORPUS.map((c) => c.name)).size, CORPUS.length, 'test names are unique');
  assert.match(connectorBuilt.boundary ?? '', /_mix$/);
});

for (const c of CORPUS) {
  const text = textOf(c);

  if (c.exact !== false) {
    test(`${c.name}: parse + serialize reproduces the message byte for byte`, () => {
      const out = serializeMessage(parseMessage(c.raw));
      assert.ok(Buffer.isBuffer(out));
      assert.equal(out.toString('latin1'), text);
      assert.ok(out.equals(Buffer.from(text, 'latin1')));
    });
  }

  test(`${c.name}: part ids, types, header fields, body entity and attachments`, () => {
    const msg = parseMessage(c.raw);
    assert.deepEqual(tree(msg), c.tree);
    assertShape(msg);
    assert.deepEqual(msg.headers, splitHead(text).fields);
    if (c.boundary !== undefined) assert.equal(msg.boundary, c.boundary);
    assert.equal(bodyEntity(msg)?.partId ?? null, c.body);
    if (c.body !== null) assert.equal(bodyEntity(msg), [...walk(msg)].find((e) => e.partId === c.body), 'bodyEntity returns the entity in the tree');
    assert.deepEqual(attachmentsOf(msg), c.attachments);
  });

  if (c.exact === false) continue;

  test(`${c.name}: setHeader edits To, Subject, Cc and adds a field without touching any other byte`, () => {
    const msg = parseMessage(c.raw);
    const { fields, tail } = splitHead(text);
    const subject = 'Re: Budget review (updated)\r\n and folded by the caller';
    setHeader(msg, 'To', 'Zed Example <zed@example.com>');
    setHeader(msg, 'Subject', subject);
    setHeader(msg, 'Cc', undefined);
    setHeader(msg, 'X-Draft-Revision', '2');
    let expected = setField(fields, 'To', 'Zed Example <zed@example.com>');
    expected = setField(expected, 'Subject', subject);
    expected = setField(expected, 'Cc', undefined);
    expected = setField(expected, 'X-Draft-Revision', '2');
    assert.deepEqual(msg.headers, expected);
    assert.equal(serialize(msg), joinHead(expected, tail));
    assert.deepEqual(headerValues(msg, 'to'), ['Zed Example <zed@example.com>']);
    assert.deepEqual(headerValues(msg, 'SUBJECT'), ['Re: Budget review (updated) and folded by the caller']);
    assert.deepEqual(headerValues(msg, 'Cc'), []);
    assert.deepEqual(tree(msg), c.tree);
  });

  if (!c.skipReplaceBody) {
    test(`${c.name}: replaceBody swaps the text and keeps attachments and other header fields`, () => {
      const msg = parseMessage(c.raw);
      replaceBody(msg, parseEntity(NEW_BODY));
      const out = serialize(msg);
      let expectedTree: Tree;
      let expectedAttachments: Attachment[];
      if (isMixed(c)) {
        // The body part is replaced in place; every other byte stays.
        assert.ok(c.body !== null && c.body !== '');
        const bodyId = c.body;
        const part = topParts(text, c.boundary!).parts[Number(bodyId)]!;
        assert.equal(out, text.slice(0, part.start) + NEW_BODY + text.slice(part.end));
        expectedTree = sortTree([
          ...c.tree.filter(([id]) => !within(id, bodyId)),
          ...NEW_BODY_TREE.map(([id, type]): [string, string] => [joinId(bodyId, id), type]),
        ]);
        expectedAttachments = c.attachments.filter((a) => !within(a.partId, bodyId));
      } else {
        // The message is the body: its Content-* fields become the replacement's, everything else stays in order.
        const replacement = splitHead(NEW_BODY);
        assert.deepEqual(otherFields(msg.headers), otherFields(splitHead(text).fields));
        // spec reading: where the new Content-* fields go is not specified; only their own order is checked.
        assert.deepEqual(contentFields(msg.headers), contentFields(replacement.fields));
        assert.ok(out.startsWith(msg.headers.map((h) => h + CRLF).join('') + CRLF), 'serialization writes the header fields as they are');
        assert.ok(out.endsWith(CRLF + replacement.tail), 'the new body follows the blank line unchanged');
        expectedTree = NEW_BODY_TREE;
        expectedAttachments = [];
      }
      assert.deepEqual(tree(msg), expectedTree);
      assert.deepEqual(tree(reparse(out)), expectedTree);
      assert.deepEqual(attachmentsOf(msg), expectedAttachments);
      assert.equal(bodyEntity(msg)?.partId, c.body);
    });
  }

  const removable = c.attachments.filter((a) => /^\d+$/.test(a.partId) && a.partId !== c.body).at(-1);
  if (removable) {
    test(`${c.name}: removeParts takes out attachment ${removable.partId} and renumbers, nothing else changes`, () => {
      const msg = parseMessage(c.raw);
      const removed = removeParts(msg, [removable.partId]);
      assert.equal(removed.length, 1);
      assert.equal(removed[0]!.type, removable.type);
      const k = Number(removable.partId);
      const { opens, close } = topParts(text, c.boundary!);
      const expectedText = text.slice(0, opens[k]) + text.slice(opens[k + 1] ?? close);
      const expectedAttachments = c.attachments
        .filter((a) => a !== removable)
        .map((a) => ({ ...a, partId: idAfterRemoval(a.partId, removable.partId) }));
      assertTopLevelRemoval(msg, c, expectedText, removeFromTree(c.tree, removable.partId), expectedAttachments);
    });
  }

  test(`${c.name}: addParts appends an attachment`, () => {
    const msg = parseMessage(c.raw);
    addParts(msg, [parseEntity(NEW_ATTACHMENT)]);
    const out = serialize(msg);
    let expectedTree: Tree;
    let expectedAttachments: Attachment[];
    let expectedBody: string | null;
    if (isMixed(c)) {
      // The new part goes right before the close delimiter; every other byte stays.
      const { opens, close } = topParts(text, c.boundary!);
      assert.equal(out, text.slice(0, close) + `--${c.boundary}${CRLF}${NEW_ATTACHMENT}${CRLF}` + text.slice(close));
      const id = String(opens.length);
      expectedTree = [...c.tree, [id, 'application/pdf']];
      expectedAttachments = [...c.attachments, newAttachment(id)];
      expectedBody = c.body;
      assert.deepEqual(tree(msg), expectedTree);
      assert.deepEqual(attachmentsOf(msg), expectedAttachments);
      // Removing the new part again restores the original bytes.
      const removed = removeParts(msg, [id]);
      assert.equal(removed.length, 1);
      assert.equal(serialize(msg), text);
      assert.deepEqual(tree(msg), c.tree);
      return;
    }
    // The message becomes multipart/mixed; its old content moves into a new first part.
    const { fields, tail } = splitHead(text);
    const boundary = msg.boundary ?? '';
    assert.equal(msg.type, 'multipart/mixed');
    assert.match(boundary, /^=_[0-9a-f]{24}$/i);
    const ct = contentFields(msg.headers);
    assert.equal(ct.length, 1, 'the message keeps a single Content-* field');
    // spec reading: the boundary starts with "=", a tspecial, so RFC 2045 requires it quoted.
    assert.equal(ct[0]!.replace(/\r\n(?=[ \t])/g, '').replace(/;\s+/, '; '), `Content-Type: multipart/mixed; boundary="${boundary}"`);
    const hadMimeVersion = fields.some((f) => fieldName(f) === 'mime-version');
    assert.deepEqual(
      otherFields(msg.headers).filter((f) => hadMimeVersion || fieldName(f) !== 'mime-version'),
      otherFields(fields),
      'every other header field stays, in order',
    );
    assert.equal(headerValues(msg, 'MIME-Version').length, 1);
    if (!hadMimeVersion) assert.deepEqual(headerValues(msg, 'MIME-Version'), ['1.0']);
    const first = msg.parts?.[0];
    assert.ok(first);
    assert.deepEqual(first.headers, contentFields(fields));
    assert.ok(out.startsWith(msg.headers.map((h) => h + CRLF).join('') + CRLF));
    const firstPart = entityText(contentFields(fields), tail.slice(2));
    assert.ok(
      out.includes(`--${boundary}${CRLF}${firstPart}${CRLF}--${boundary}${CRLF}${NEW_ATTACHMENT}${CRLF}--${boundary}--`),
      'the old content, byte for byte, is the first part; the attachment the second',
    );
    assert.equal(out.split(boundary).length - 1, 4, 'the boundary occurs only in the header field and the three delimiter lines');
    expectedTree = sortTree([
      ['', 'multipart/mixed'],
      ...c.tree.map(([id, type]): [string, string] => [joinId('0', id), type]),
      ['1', 'application/pdf'],
    ]);
    expectedAttachments = [...c.attachments.map((a) => ({ ...a, partId: joinId('0', a.partId) })), newAttachment('1')];
    expectedBody = c.attachments.some((a) => a.partId === '') ? null : '0';
    assert.deepEqual(tree(msg), expectedTree);
    assert.deepEqual(tree(reparse(out)), expectedTree);
    assert.deepEqual(attachmentsOf(msg), expectedAttachments);
    assert.equal(bodyEntity(msg)?.partId ?? null, expectedBody);
  });

  test(`${c.name}: removeParts refuses the message, the body and unknown ids, and changes nothing`, () => {
    const msg = parseMessage(c.raw);
    const refused = ['', '42', '0.9.9', ...(c.body ? [c.body] : [])];
    for (const id of refused) {
      assert.throws(
        () => removeParts(msg, [id]),
        (e: unknown) => e instanceof MimeEditError && e.message.length > 0,
        `part id ${JSON.stringify(id)}`,
      );
      assert.equal(serialize(msg), text);
    }
  });
}

// ---------------------------------------------------------------------------
// Parsing details
// ---------------------------------------------------------------------------

test('MimeEditError is an Error named MimeEditError', () => {
  const e = new MimeEditError('Part 7 does not exist.');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof MimeEditError);
  assert.equal(e.name, 'MimeEditError');
  assert.equal(e.message, 'Part 7 does not exist.');
});

test('leaf bodies run from the blank line to the CRLF that belongs to the next delimiter', () => {
  const msg = parseMessage(gmailAlternative.raw);
  const [plain, html] = msg.parts ?? [];
  assert.deepEqual(plain?.headers, ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable']);
  assert.equal(plain?.body, crlf('Hi Ann,', '', 'Here are the Q3 numbers =E2=80=94 see the summary below.', '', 'Thanks,', 'Sebastian', ''));
  assert.equal(
    html?.body,
    crlf(
      '<div dir=3D"ltr"><div>Hi Ann,</div><div><br></div><div>Here are the Q3 numbe=',
      'rs =E2=80=94 see the <b>summary</b> below.</div><div><br></div><div>Thanks,=',
      '</div><div>Sebastian</div></div>',
      '',
    ),
  );

  const empty = parseMessage(gmailEmptyBody.raw).parts?.[0]?.parts?.[0];
  assert.equal(empty?.body, CRLF, 'Gmail stores an empty text part as a single line break');
});

test('folded header fields of a part are kept exactly, and its base64 body is untouched', () => {
  const pdf = parseMessage(gmailAttachments.raw).parts?.[1];
  assert.deepEqual(pdf?.headers, G4_PDF_HEADERS);
  assert.equal(pdf?.body, b64(PDF_CONTRACT));
});

test('RFC 2046 sample: headerless part, body without final line break, preamble and epilogue', () => {
  const msg = parseMessage(rfc2046Sample.raw);
  const [implicit, explicit] = msg.parts ?? [];
  assert.deepEqual(implicit?.headers, []);
  assert.equal(implicit?.type, 'text/plain');
  assert.equal(implicit?.body, crlf('This is implicitly typed plain US-ASCII text.', 'It does NOT end with a linebreak.'));
  assert.deepEqual(explicit?.headers, ['Content-type: text/plain; charset=us-ascii']);
  assert.equal(explicit?.body, crlf('This is explicitly typed plain US-ASCII text.', 'It DOES end with a linebreak.', ''));
  // spec reading: whether preamble/epilogue include their adjacent CRLFs is left to the implementation.
  assert.ok(msg.preamble?.includes('This is the preamble.  It is to be ignored, though it'));
  assert.ok(msg.epilogue?.includes('This is the epilogue.  It is also to be ignored.'));
});

test('message/rfc822 and message/global are leaves even when they contain multiparts', () => {
  const forward = parseMessage(gmailForward.raw).parts?.[1];
  assert.equal(forward?.type, 'message/rfc822');
  assert.equal(forward?.parts, undefined);
  assert.equal(forward?.body, FORWARDED);

  const raw = crlf(
    'From: Sebastian Ko <seb@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="g-7"',
    '',
    '--g-7',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'See the attached message.',
    '--g-7',
    'Content-Type: message/global',
    'Content-Disposition: attachment; filename="forwarded.u8msg"',
    '',
    'Subject: inner',
    'Content-Type: multipart/mixed; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain',
    '',
    'x',
    '--inner--',
    '--g-7--',
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'message/global'],
  ]);
  assert.equal(msg.parts?.[1]?.parts, undefined);
  assert.equal(roundTrip(raw), raw);
});

test('headerValues unfolds, ignores case, keeps order and leaves encoded-words alone', () => {
  const reply = parseMessage(gmailReply.raw);
  assert.deepEqual(headerValues(reply, 'references'), [
    '<CAB7wQ2s1Yx0Lk9mZc3Vn8Rt6Ue4Pa2Hd5Gf7Jb1Kq0Xw@mail.gmail.com> <CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>',
  ]);
  assert.deepEqual(headerValues(reply, 'In-Reply-To'), ['<CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>']);
  assert.deepEqual(headerValues(reply, 'CC'), ['Bob Stone <bob@example.net>, Carla Diaz <carla@example.org>']);
  assert.deepEqual(headerValues(reply, 'Bcc'), []);

  const tb = parseMessage(thunderbirdAttachment.raw);
  assert.deepEqual(headerValues(tb, 'Subject'), ['=?UTF-8?B?0J7RgtGH0ZHRgiDQt9CwINGB0LXQvdGC0Y/QsdGA0Yw=?=']);

  const outlook = parseMessage(outlookExchange.raw);
  assert.deepEqual(headerValues(outlook, 'cc'), ['Legal Team <legal@contoso.example>']);
  // spec reading: the value starts after the colon and the white space that follows it, even across a fold.
  assert.deepEqual(headerValues(outlook, 'Message-ID'), ['<DM6PR11MB46581A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7@DM6PR11MB4658.namprd11.prod.outlook.com>']);
  // spec reading: a field with nothing after the colon has the empty value.
  assert.deepEqual(headerValues(outlook, 'X-MS-TNEF-Correlator'), ['']);

  const cron = parseMessage(cronPlain.raw);
  const received = headerValues(cron, 'Received').map((v) => v.replace(/\s+/g, ' '));
  assert.deepEqual(received, [
    'by build.example.com (Postfix, from userid 0) id 4F1A22C0E1; Thu, 24 Sep 2026 03:00:01 +0000 (UTC)',
    'from build.example.com (localhost [127.0.0.1]) by build.example.com (Postfix) with ESMTP id 4F1A22C0E0 for <seb@example.com>; Thu, 24 Sep 2026 03:00:00 +0000 (UTC)',
  ]);
  for (const v of headerValues(cron, 'Received')) assert.ok(!v.includes('\r') && !v.includes('\n'), 'values are unfolded');
});

test('headerValues returns 8-bit header bytes unchanged (one character per byte)', () => {
  const msg = parseMessage(utf8Headers.raw);
  // spec reading: the parser works on a latin1 string, so values of raw UTF-8 fields are binary
  // strings. "voilà" ends in the byte 0xA0, which String.prototype.trim would wrongly strip.
  const [subject] = headerValues(msg, 'Subject');
  assert.equal(Buffer.from(subject ?? '', 'latin1').toString('utf8'), "Réunion d'équipe, voilà");
  const [from] = headerValues(msg, 'From');
  assert.equal(Buffer.from(from ?? '', 'latin1').toString('utf8'), 'Zoë Müller <zoe@example.ch>');
});

test('line breaks: LF-only, CR-only and mixed input are normalised to CRLF', () => {
  const lfOnly = parseMessage(muttLf.raw);
  assert.equal(lfOnly.parts?.[1]?.body, SERVER_LOG);
  assert.equal(serialize(lfOnly), normalize(muttLf.raw.toString('latin1')));

  const crOnly = ['From: a@example.com', 'Content-Type: multipart/alternative; boundary="x"', '', '--x', 'Content-Type: text/plain', '', 'one', '--x', 'Content-Type: text/html', '', '<p>one</p>', '--x--', ''].join('\r');
  assert.equal(roundTrip(crOnly), normalize(crOnly));
  assert.deepEqual(tree(parseMessage(Buffer.from(crOnly, 'latin1'))), [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ]);

  const mixed = 'From: a@example.com\nSubject: mixed\r\nContent-Type: text/plain\r\r\nline one\rline two\n';
  assert.equal(roundTrip(mixed), 'From: a@example.com\r\nSubject: mixed\r\nContent-Type: text/plain\r\n\r\nline one\r\nline two\r\n');
  assert.equal(parseMessage(Buffer.from(mixed, 'latin1')).body, 'line one\r\nline two\r\n');
});

test('a multipart without its close delimiter is tolerated and gets one when serialized', () => {
  const text = textOf(truncated);
  const msg = parseMessage(truncated.raw);
  const out = serialize(msg);
  const lastContent = b64(PDF_CUT);
  const kept = text.indexOf(lastContent) + lastContent.length;
  assert.equal(out.slice(0, kept), text.slice(0, kept), 'everything up to the end of the last part is unchanged');
  // spec reading: the line breaks between the last part and the written close delimiter are not pinned down.
  assert.match(out.slice(kept), new RegExp(`^(\\r\\n)*--${TRUNC}--(\\r\\n)?$`));
  const again = reparse(out);
  assert.deepEqual(tree(again), truncated.tree);
  assert.equal(serialize(again), out, 'once written, the close delimiter round-trips');

  // Edits still work, and the attachment keeps its content.
  addParts(msg, [parseEntity(NEW_ATTACHMENT)]);
  const edited = reparse(serialize(msg));
  assert.deepEqual(tree(edited), [...truncated.tree, ['2', 'application/pdf']]);
  assert.deepEqual(attachmentsOf(edited), [...truncated.attachments, newAttachment('2')]);
});

test('a multipart without a boundary parameter, or without any delimiter line, is a leaf', () => {
  const noBoundary = crlf(
    'From: a@example.com',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed',
    '',
    '--whatever',
    'Content-Type: text/plain',
    '',
    'x',
    '--whatever--',
    '',
  );
  const a = parseMessage(bytes(noBoundary));
  assert.equal(a.type, 'multipart/mixed');
  assert.equal(a.parts, undefined);
  assert.equal(a.body, crlf('--whatever', 'Content-Type: text/plain', '', 'x', '--whatever--', ''));
  assert.equal(roundTrip(noBoundary), noBoundary);

  const noDelimiter = crlf(
    'From: a@example.com',
    'Content-Type: multipart/alternative; boundary="never-used"',
    '',
    'Just some text without a delimiter line.',
    '--never-used-but-not-a-delimiter',
    ' --never-used',
    '',
  );
  const b = parseMessage(bytes(noDelimiter));
  assert.equal(b.type, 'multipart/alternative');
  assert.equal(b.parts, undefined);
  assert.equal(typeof b.body, 'string');
  assert.equal(roundTrip(noDelimiter), noDelimiter);
});

test('a delimiter line must be exactly "--" + boundary (plus white space), not a line that starts with it', () => {
  const raw = crlf(
    'From: a@example.com',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: multipart/alternative; boundary="outer-inner"',
    '',
    '--outer-inner',
    'Content-Type: text/plain',
    '',
    'text',
    '--outer-inner',
    'Content-Type: text/html',
    '',
    '<p>text</p>',
    '--outer-inner--',
    '',
    '--outer',
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    '',
    '--outerwear is not a delimiter',
    '--outer --not a close delimiter either',
    '--outer--',
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/alternative'],
    ['0.0', 'text/plain'],
    ['0.1', 'text/html'],
    ['1', 'text/plain'],
  ]);
  assert.equal(msg.parts?.[1]?.body, crlf('--outerwear is not a delimiter', '--outer --not a close delimiter either'));
  assert.equal(roundTrip(raw), raw);
});

test('delimiter lines may carry trailing spaces and tabs (transport padding), which round-trip', () => {
  const raw = crlf(
    'From: a@example.com',
    'Content-Type: multipart/alternative; boundary="pad"',
    '',
    '--pad   ',
    'Content-Type: text/plain',
    '',
    'one',
    '--pad\t',
    'Content-Type: text/html',
    '',
    '<p>two</p>',
    '--pad-- \t',
    'epilogue',
  );
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ]);
  assert.equal(msg.parts?.[0]?.body, 'one');
  assert.equal(msg.parts?.[1]?.body, '<p>two</p>');
  assert.equal(roundTrip(raw), raw);
});

/** A message nested `levels` multiparts deep, with one text part at the bottom. */
function nestedMessage(levels: number): string {
  const open: string[] = [];
  const close: string[] = [];
  for (let i = 0; i < levels; i++) {
    open.push(`Content-Type: multipart/mixed; boundary="lvl${i}"`, '', `--lvl${i}`);
    close.unshift(`--lvl${i}--`);
  }
  return crlf('From: a@example.com', 'Subject: nested', 'MIME-Version: 1.0', ...open, 'Content-Type: text/plain', '', 'bottom', ...close, '');
}

function parsedDepth(msg: MimeEntity): { levels: number; bottom: MimeEntity } {
  let bottom = msg;
  let levels = 0;
  while (bottom.parts) {
    levels++;
    bottom = bottom.parts[0]!;
  }
  return { levels, bottom };
}

test('nested multiparts are parsed up to depth 40; deeper ones stay leaves and still round-trip', () => {
  const shallow = nestedMessage(10);
  const s = parsedDepth(parseMessage(bytes(shallow)));
  assert.equal(s.levels, 10);
  assert.equal(s.bottom.type, 'text/plain');
  assert.equal(s.bottom.partId, Array(10).fill('0').join('.'));
  assert.equal(roundTrip(shallow), shallow);

  const deep = nestedMessage(45);
  const d = parsedDepth(parseMessage(bytes(deep)));
  // spec reading: whether the message itself counts as depth 0 or 1 is open; 39 to 41 parsed levels are accepted.
  assert.ok(d.levels >= 39 && d.levels <= 41, `parsed ${d.levels} levels`);
  assert.equal(d.bottom.type, 'multipart/mixed');
  assert.equal(typeof d.bottom.body, 'string');
  assert.equal(roundTrip(deep), deep);

  const hostile = nestedMessage(3000);
  assert.equal(roundTrip(hostile), hostile, 'no stack overflow');
});

test('Content-Type: case, comments, white space around "=", quoted values', () => {
  const raw = crlf(
    'From: a@example.com',
    'MIME-Version: 1.0 (produced by MetaSend Vx.x)',
    'Content-Type: Multipart/Mixed (generated; boundary="decoy") ; BOUNDARY = "real=_1.2+3"',
    '',
    '--real=_1.2+3',
    'Content-Type: TEXT/PLAIN (body text); Charset = "us-ascii"',
    '',
    'hello',
    '--decoy',
    'still the first part',
    '--real=_1.2+3',
    'Content-Type: Application/Octet-Stream; name = "data.bin"',
    'Content-Disposition: attachment',
    '',
    'AAAA',
    '--real=_1.2+3--',
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.equal(msg.boundary, 'real=_1.2+3');
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/octet-stream'],
  ]);
  assert.equal(msg.parts?.[0]?.body, crlf('hello', '--decoy', 'still the first part'));
  assert.equal(roundTrip(raw), raw);
});

test('quoted boundaries keep spaces and parentheses and lose backslash escapes', () => {
  const raw = crlf(
    'Content-Type: multipart/alternative; boundary="(not a comment) \\=_x"',
    '',
    '--(not a comment) =_x',
    'Content-Type: text/plain',
    '',
    'plain',
    '--(not a comment) =_x',
    'Content-Type: text/html',
    '',
    '<p>html</p>',
    '--(not a comment) =_x--',
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.equal(msg.boundary, '(not a comment) =_x');
  assert.deepEqual(tree(msg), [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'text/html'],
  ]);
  assert.equal(roundTrip(raw), raw);
});

test('absent or unparsable Content-Type means text/plain; types are lower-cased', () => {
  const typeOf = (field: string | undefined) => parseEntity(field === undefined ? crlf('Content-Disposition: inline', '', 'x') : crlf(field, '', 'x')).type;
  assert.equal(typeOf(undefined), 'text/plain');
  assert.equal(typeOf('Content-Type:'), 'text/plain');
  assert.equal(typeOf('Content-Type: garbage'), 'text/plain');
  assert.equal(typeOf('Content-Type: text/'), 'text/plain');
  assert.equal(typeOf('Content-Type: IMAGE/PNG; name=x.png'), 'image/png');
  assert.equal(typeOf('content-type:  text/html ; charset=utf-8'), 'text/html');
  assert.equal(typeOf('Content-Type: application/vnd.ms-excel.sheet.macroEnabled.12'), 'application/vnd.ms-excel.sheet.macroenabled.12');
});

test('messages without a body, without header fields or empty survive a round trip', () => {
  for (const raw of ['', 'From: a@example.com\r\nSubject: no body\r\n', 'From: a@example.com\r\n\r\n', '\r\nJust a body, no header fields.\r\n']) {
    assert.equal(roundTrip(raw), raw, JSON.stringify(raw));
  }
  const headerOnly = parseMessage(bytes('From: a@example.com\r\nSubject: no body\r\n'));
  assert.deepEqual(headerOnly.headers, ['From: a@example.com', 'Subject: no body']);
  assert.equal(headerOnly.type, 'text/plain');
  assert.equal(headerOnly.body, '');
  const bodyOnly = parseMessage(bytes('\r\nJust a body, no header fields.\r\n'));
  assert.deepEqual(bodyOnly.headers, []);
  assert.equal(bodyOnly.body, 'Just a body, no header fields.\r\n');
});

test('parts without a blank line or without header fields round-trip', () => {
  const raw = crlf(
    'Content-Type: multipart/mixed; boundary="e"',
    '',
    '--e',
    'Content-Type: text/plain',
    '',
    '--e',
    '',
    'no header fields here',
    '--e--',
    '',
  );
  const msg = parseMessage(bytes(raw));
  const [headersOnly, bodyOnly] = msg.parts ?? [];
  assert.deepEqual(headersOnly?.headers, ['Content-Type: text/plain']);
  assert.equal(headersOnly?.body, '');
  assert.deepEqual(bodyOnly?.headers, []);
  assert.equal(bodyOnly?.body, 'no header fields here');
  assert.equal(roundTrip(raw), raw);
});

test('malformed header lines stay in place and are never mistaken for fields', () => {
  const raw = crlf(
    'From MAILER-DAEMON Thu Sep 24 08:00:12 2026',
    'From: Real Sender <real@example.com>',
    'X-Broken header line without a colon',
    'To: seb@example.com',
    'Subject: malformed',
    'Content-Type: text/plain',
    '',
    'body',
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(msg.headers, raw.split(CRLF).slice(0, 6));
  // spec reading: "From MAILER-DAEMON ..." is not "Name: value" (a field name has no spaces), so it is not a From field.
  assert.deepEqual(headerValues(msg, 'From'), ['Real Sender <real@example.com>']);
  setHeader(msg, 'Subject', 'fixed');
  setHeader(msg, 'From', 'Other <other@example.com>');
  assert.equal(serialize(msg), raw.replace('Subject: malformed', 'Subject: fixed').replace('From: Real Sender <real@example.com>', 'From: Other <other@example.com>'));
});

test('every byte value except line breaks round-trips', () => {
  const payload = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256).filter((b) => b !== 10 && b !== 13));
  const raw = Buffer.concat([bytes('Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n'), payload]);
  assert.ok(serializeMessage(parseMessage(raw)).equals(raw));
  assert.ok(Buffer.from(parseMessage(raw).body ?? '', 'latin1').equals(payload));
});

test('parseEntity parses connector-built leaves and multiparts', () => {
  const leaf = parseEntity(NEW_ATTACHMENT);
  assert.equal(leaf.type, 'application/pdf');
  assert.deepEqual(leaf.headers, NEW_ATTACHMENT.split(CRLF).slice(0, 3));
  assert.equal(leaf.body, b64(PDF_MINUTES));
  assert.equal(leaf.parts, undefined);

  const alt = parseEntity(NEW_BODY);
  assert.equal(alt.type, 'multipart/alternative');
  assert.equal(alt.boundary, NEW_ALT);
  assert.deepEqual(
    alt.parts?.map((p) => p.type),
    ['text/plain', 'text/html'],
  );
  assert.equal(alt.parts?.[0]?.body, b64(bytes('Updated text — ünïcödé\r\n')));
});

// ---------------------------------------------------------------------------
// listAttachments details
// ---------------------------------------------------------------------------

const FILE_A = fakeFile('%PDF', 10, 31);
const FILE_B = fakeFile('BIN', 11, 32);
const FILE_C = fakeFile('%PDF', 12, 33);
const FILE_D = fakeFile('GIF89a', 43, 34);
const FILE_E = fakeFile('%PDF-1.4\n', 3001, 35);
const FILENAMES = crlf(
  'From: a@example.com',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="files"',
  '',
  '--files',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'Files below.',
  '--files',
  'Content-Type: application/pdf; name="fallback.pdf"',
  'Content-Disposition: attachment; filename="fallback.pdf";',
  " filename*=UTF-8''%E2%82%AC%20rates%202026.pdf",
  'Content-Transfer-Encoding: base64',
  '',
  b64(FILE_A),
  '--files',
  'Content-Type: application/octet-stream; name="from-content-type.bin"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(FILE_B),
  '--files',
  'Content-Type: text/plain; charset=utf-8; name="ignored-name.txt"',
  'Content-Disposition: attachment; filename="preferred-name.txt"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'caf=C3=A9 au lait=',
  '--files',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment;',
  " filename*0*=utf-8'en'%E2%82%AC;",
  ' filename*1=" and more";',
  ' filename*2*=%20%C3%A9t%C3%A9.pdf',
  'Content-Transfer-Encoding: base64',
  '',
  b64(FILE_C),
  '--files',
  'Content-Type: image/gif',
  'Content-ID: <spacer@example.com>',
  'Content-Transfer-Encoding: BASE64',
  '',
  b64(FILE_D),
  '--files',
  'Content-Type: application/pdf; name=report_2026.pdf',
  'Content-Disposition: attachment; filename=report_2026.pdf',
  'Content-Transfer-Encoding: base64',
  '',
  b64(FILE_E, 60),
  '',
  '--files',
  'Content-Type: text/plain; name="=?ISO-8859-1?Q?Gr=FC=DFe_aus_K=F6ln.txt?="',
  'Content-Disposition: attachment; filename="=?ISO-8859-1?Q?Gr=FC=DFe_aus_K=F6ln.txt?="',
  '',
  'plain 7bit text',
  '--files--',
  '',
);

test('listAttachments decodes every filename form and computes decoded sizes', () => {
  const msg = parseMessage(bytes(FILENAMES));
  assert.equal(roundTrip(FILENAMES), FILENAMES);
  assert.equal(bodyEntity(msg)?.partId, '0');
  assert.deepEqual(attachmentsOf(msg), [
    // spec reading: filename*= (RFC 2231) wins over the plain filename= fallback.
    att('1', '€ rates 2026.pdf', 'application/pdf', FILE_A),
    // spec reading: without Content-Disposition, a name= parameter makes an attachment (not inline).
    att('2', 'from-content-type.bin', 'application/octet-stream', FILE_B),
    // spec reading: Content-Disposition filename wins over Content-Type name; quoted-printable size is the raw length.
    att('3', 'preferred-name.txt', 'text/plain', 'caf=C3=A9 au lait='.length),
    // RFC 2231 continuations may mix encoded (*N*) and plain (*N) segments; only the first carries the charset.
    att('4', '€ and more été.pdf', 'application/pdf', FILE_C),
    // spec reading: a part with a Content-ID and no disposition is an inline file with no filename.
    att('5', undefined, 'image/gif', FILE_D, true),
    // Unquoted token filename; base64 in 60-character lines with a trailing blank line.
    att('6', 'report_2026.pdf', 'application/pdf', FILE_E),
    // RFC 2047 Q-encoding with an upper-case charset label, '_' for space.
    att('7', 'Grüße aus Köln.txt', 'text/plain', 'plain 7bit text'.length),
  ]);
});

// ---------------------------------------------------------------------------
// setHeader details
// ---------------------------------------------------------------------------

test('setHeader replaces every occurrence (any case) by one field at the first position', () => {
  const raw = crlf('From: a@example.com', 'Cc: one@example.com', 'Subject: duplicates', 'cc: two@example.com,', ' three@example.com', 'Content-Type: text/plain', '', 'body', '');
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(headerValues(msg, 'Cc'), ['one@example.com', 'two@example.com, three@example.com']);
  setHeader(msg, 'Cc', 'four@example.com');
  assert.equal(serialize(msg), crlf('From: a@example.com', 'Cc: four@example.com', 'Subject: duplicates', 'Content-Type: text/plain', '', 'body', ''));

  // A folded value is written as given, at the end of the header block when the field is new.
  setHeader(msg, 'To', 'Ann Lee <ann@example.com>,\r\n Bob Stone <bob@example.net>');
  assert.equal(
    serialize(msg),
    crlf('From: a@example.com', 'Cc: four@example.com', 'Subject: duplicates', 'Content-Type: text/plain', 'To: Ann Lee <ann@example.com>,', ' Bob Stone <bob@example.net>', '', 'body', ''),
  );
  assert.deepEqual(headerValues(msg, 'To'), ['Ann Lee <ann@example.com>, Bob Stone <bob@example.net>']);

  // Removing an absent field changes nothing.
  const before = serialize(msg);
  setHeader(msg, 'Bcc', undefined);
  assert.equal(serialize(msg), before);
});

test('setHeader on a part changes only that part', () => {
  const text = textOf(gmailAttachments);
  const msg = parseMessage(gmailAttachments.raw);
  const docx = msg.parts?.[2];
  assert.ok(docx);
  setHeader(docx, 'Content-Disposition', 'attachment; filename="Annex A (signed).docx"');
  assert.equal(
    serialize(msg),
    text.replace('Content-Disposition: attachment; filename="Annexe A.docx"', 'Content-Disposition: attachment; filename="Annex A (signed).docx"'),
  );
});

test('setHeader keeps raw 8-bit fields of other headers byte for byte', () => {
  const msg = parseMessage(utf8Headers.raw);
  setHeader(msg, 'Subject', '=?UTF-8?Q?R=C3=A9union_d=C3=A9plac=C3=A9e?=');
  const out = serializeMessage(msg);
  const expected = normalize(utf8Headers.raw.toString('latin1')).replace(
    Buffer.from("Subject: Réunion d'équipe, voilà", 'utf8').toString('latin1'),
    'Subject: =?UTF-8?Q?R=C3=A9union_d=C3=A9plac=C3=A9e?=',
  );
  assert.ok(out.equals(Buffer.from(expected, 'latin1')));
  assert.ok(out.includes(bytes('From: Zoë Müller <zoe@example.ch>')));
});

// ---------------------------------------------------------------------------
// removeParts details
// ---------------------------------------------------------------------------

test('removeParts removes several attachments at once', () => {
  const text = textOf(gmailAttachments);
  const msg = parseMessage(gmailAttachments.raw);
  const removed = removeParts(msg, ['2', '1']);
  assert.deepEqual(removed.map((p) => p.type).sort(), ['application/pdf', DOCX]);
  const { opens, close } = topParts(text, G4);
  assertTopLevelRemoval(msg, gmailAttachments, text.slice(0, opens[1]) + text.slice(close), gmailAttachments.tree.slice(0, 4), []);
});

test('removeParts can drop an image pasted into the text; the related part stays with the text alone', () => {
  const text = textOf(gmailImageAndAttachment);
  const msg = parseMessage(gmailImageAndAttachment.raw);
  const removed = removeParts(msg, ['0.1']);
  assert.equal(removed[0]?.type, 'image/png');
  const start = text.indexOf(`--${G5R}\r\nContent-Type: image/png`);
  const end = text.indexOf(`--${G5R}--`);
  assert.ok(start > 0 && end > start);
  assert.equal(serialize(msg), text.slice(0, start) + text.slice(end));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'multipart/related'],
    ['0.0', 'multipart/alternative'],
    ['0.0.0', 'text/plain'],
    ['0.0.1', 'text/html'],
    ['1', 'application/pdf'],
  ]);
  assert.deepEqual(attachmentsOf(msg), [att('1', 'Invoice 1042.pdf', 'application/pdf', PDF_INVOICE)]);
  assert.equal(bodyEntity(msg)?.partId, '0');

  const apple = parseMessage(appleHtmlImage.raw);
  const appleText = textOf(appleHtmlImage);
  removeParts(apple, ['1.1']);
  const s = appleText.indexOf(`--${APPLE_REL}\r\nContent-Transfer-Encoding: base64`);
  const e = appleText.indexOf(`--${APPLE_REL}--`);
  assert.equal(serialize(apple), appleText.slice(0, s) + appleText.slice(e));
  assert.deepEqual(tree(apple), [
    ['', 'multipart/alternative'],
    ['0', 'text/plain'],
    ['1', 'multipart/related'],
    ['1.0', 'text/html'],
  ]);
});

test('removeParts also removes a multipart it leaves empty', () => {
  const raw = crlf(
    'From: a@example.com',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="top"',
    '',
    '--top',
    'Content-Type: text/plain',
    '',
    'See the two scans.',
    '--top',
    'Content-Type: multipart/mixed; boundary="scans"',
    '',
    '--scans',
    'Content-Type: application/pdf; name="a.pdf"',
    'Content-Disposition: attachment; filename="a.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--scans',
    'Content-Type: application/pdf; name="b.pdf"',
    'Content-Disposition: attachment; filename="b.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjcK',
    '--scans--',
    '',
    '--top',
    'Content-Type: text/plain; name="c.txt"',
    'Content-Disposition: attachment; filename="c.txt"',
    '',
    'c',
    '--top--',
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(attachmentsOf(msg), [att('1.0', 'a.pdf', 'application/pdf', 9), att('1.1', 'b.pdf', 'application/pdf', 9), att('2', 'c.txt', 'text/plain', 1)]);
  const removed = removeParts(msg, ['1.0', '1.1']);
  assert.equal(removed.length, 2);
  const { opens } = topParts(raw, 'top');
  assert.equal(serialize(msg), raw.slice(0, opens[1]) + raw.slice(opens[2]));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'text/plain'],
  ]);
  assert.deepEqual(attachmentsOf(msg), [att('1', 'c.txt', 'text/plain', 1)]);
});

test('removeParts refuses ids inside a message/rfc822 leaf, and fails as a whole', () => {
  const forward = parseMessage(gmailForward.raw);
  assert.throws(() => removeParts(forward, ['1.0']), MimeEditError);

  const text = textOf(gmailAttachments);
  const msg = parseMessage(gmailAttachments.raw);
  // spec reading: one bad id means nothing is removed (the error is reported before any change).
  assert.throws(() => removeParts(msg, ['1', '5']), MimeEditError);
  assert.equal(serialize(msg), text);
  // Same reading: the valid id '2' stays when '0', the body part, is refused.
  assert.throws(() => removeParts(msg, ['2', '0']), MimeEditError, 'the body part cannot be removed');
  assert.equal(serialize(msg), text);
});

// ---------------------------------------------------------------------------
// addParts details
// ---------------------------------------------------------------------------

test('addParts appends several parts in order', () => {
  const text = textOf(gmailAttachments);
  const msg = parseMessage(gmailAttachments.raw);
  const second = NEW_ATTACHMENT.replaceAll('minutes.pdf', 'agenda.pdf');
  addParts(msg, [parseEntity(NEW_ATTACHMENT), parseEntity(second)]);
  const { close } = topParts(text, G4);
  assert.equal(serialize(msg), text.slice(0, close) + `--${G4}\r\n${NEW_ATTACHMENT}\r\n--${G4}\r\n${second}\r\n` + text.slice(close));
  assert.deepEqual(
    attachmentsOf(msg).map((a) => [a.partId, a.filename]),
    [
      ['1', 'Contrat signé (version finale) — été 2026.pdf'],
      ['2', 'Annexe A.docx'],
      ['3', 'minutes.pdf'],
      ['4', 'agenda.pdf'],
    ],
  );
});

test('addParts generates a fresh boundary each time and keeps an existing Mime-Version', () => {
  const a = parseMessage(gmailAlternative.raw);
  const b = parseMessage(gmailAlternative.raw);
  addParts(a, [parseEntity(NEW_ATTACHMENT)]);
  addParts(b, [parseEntity(NEW_ATTACHMENT)]);
  assert.notEqual(a.boundary, b.boundary);

  const apple = parseMessage(applePlain.raw);
  addParts(apple, [parseEntity(NEW_ATTACHMENT)]);
  assert.deepEqual(headerValues(apple, 'mime-version'), ['1.0 (Mac OS X Mail 16.0 \\(3826.200.121\\))']);
  assert.deepEqual(apple.parts?.[0]?.headers, ['Content-Type: text/plain;\r\n\tcharset=utf-8', 'Content-Transfer-Encoding: quoted-printable']);
  assert.equal(apple.parts?.[0]?.body, textOf(applePlain).slice(textOf(applePlain).indexOf('\r\n\r\n') + 4));

  const cron = parseMessage(cronPlain.raw);
  addParts(cron, [parseEntity(NEW_ATTACHMENT)]);
  assert.deepEqual(headerValues(cron, 'MIME-Version'), ['1.0']);
  assert.deepEqual(cron.parts?.[0]?.headers, [], 'a message without Content-* fields gives a first part without header fields');
  assert.equal(reparse(serialize(cron)).parts?.[0]?.body, 'backup completed: 14 files, 2.3 GB\r\n');
});

// ---------------------------------------------------------------------------
// replaceBody details
// ---------------------------------------------------------------------------

test('replaceBody with plain text drops an image pasted into the old text and keeps threading headers', () => {
  const msg = parseMessage(gmailPastedImage.raw);
  replaceBody(msg, parseEntity(NEW_TEXT));
  assert.equal(msg.type, 'text/plain');
  assert.equal(msg.parts, undefined);
  assert.equal(msg.body, splitHead(NEW_TEXT).tail.slice(2));
  assert.deepEqual(contentFields(msg.headers), splitHead(NEW_TEXT).fields);
  assert.deepEqual(otherFields(msg.headers), otherFields(splitHead(textOf(gmailPastedImage)).fields));
  assert.deepEqual(attachmentsOf(msg), []);
  assert.equal(bodyEntity(msg), msg);

  const reply = parseMessage(gmailReply.raw);
  replaceBody(reply, parseEntity(NEW_TEXT));
  assert.deepEqual(headerValues(reply, 'In-Reply-To'), ['<CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>']);
  assert.deepEqual(headerValues(reply, 'References'), [
    '<CAB7wQ2s1Yx0Lk9mZc3Vn8Rt6Ue4Pa2Hd5Gf7Jb1Kq0Xw@mail.gmail.com> <CAC4mT8r2Zq9Nw1Xe6Vb3Ly7Ku0Ph5Jd8Gs2Fa4Hn1Qc@mail.gmail.com>',
  ]);
  assert.deepEqual(headerValues(reply, 'From'), ['Sebastian Ko <seb@example.com>']);
});

test('replaceBody inserts the text as the first part of a multipart/mixed that has none', () => {
  const B = '000000000000aa11bb063fb0c1d2';
  const raw = crlf(
    'MIME-Version: 1.0',
    'From: Sebastian Ko <seb@example.com>',
    'To: ann@example.com',
    'Subject: Files only',
    `Content-Type: multipart/mixed; boundary="${B}"`,
    '',
    `--${B}`,
    'Content-Type: application/pdf; name="a.pdf"',
    'Content-Disposition: attachment; filename="a.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    `--${B}--`,
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.equal(bodyEntity(msg), undefined);
  replaceBody(msg, parseEntity(NEW_TEXT));
  const first = raw.indexOf(`--${B}`);
  assert.equal(serialize(msg), raw.slice(0, first) + `--${B}\r\n${NEW_TEXT}\r\n` + raw.slice(first));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
  ]);
  assert.equal(bodyEntity(msg)?.partId, '0');
  assert.deepEqual(attachmentsOf(msg), [att('1', 'a.pdf', 'application/pdf', 9)]);
});

test('replaceBody with the same body part changes nothing', () => {
  for (const c of [gmailAttachments, outlookExchange, thunderbirdAttachment, iphonePhoto]) {
    const text = textOf(c);
    const part = topParts(text, c.boundary!).parts[Number(c.body)]!;
    const msg = parseMessage(c.raw);
    replaceBody(msg, parseEntity(text.slice(part.start, part.end)));
    assert.equal(serialize(msg), text, c.name);
    assert.deepEqual(tree(msg), c.tree, c.name);
  }
});

test('a scanned PDF becomes an attachment of a new text: addParts, then replaceBody', () => {
  const msg = parseMessage(scannerPdf.raw);
  addParts(msg, [parseEntity(NEW_ATTACHMENT)]);
  assert.equal(bodyEntity(msg), undefined, 'both parts are attachments');
  replaceBody(msg, parseEntity(NEW_TEXT));
  const expectedTree: Tree = [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
    ['2', 'application/pdf'],
  ];
  const expectedAttachments = [att('1', 'scan_20260924_080012.pdf', 'application/pdf', PDF_SCAN), newAttachment('2')];
  assert.deepEqual(tree(msg), expectedTree);
  assert.equal(bodyEntity(msg)?.partId, '0');
  assert.deepEqual(attachmentsOf(msg), expectedAttachments);
  const again = reparse(serialize(msg));
  assert.deepEqual(tree(again), expectedTree);
  assert.deepEqual(attachmentsOf(again), expectedAttachments);
  assert.equal(again.parts?.[1]?.body, b64(PDF_SCAN) + CRLF, 'the scan is carried over byte for byte');
  assert.deepEqual(headerValues(again, 'Subject'), ['Scanned document from MFP-3F']);
});

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

test('a draft with a 3 MB PDF parses, edits and serializes in reasonable time', { timeout: 30_000 }, () => {
  const big = fakeFile('%PDF-1.7\n', 3 * 1024 * 1024 + 1, 99);
  const B = '000000000000ffee00063fb1d2e3';
  const raw = bytes(
    crlf(
      'MIME-Version: 1.0',
      'From: Sebastian Ko <seb@example.com>',
      'To: ann@example.com',
      'Subject: Big file',
      `Content-Type: multipart/mixed; boundary="${B}"`,
      '',
      `--${B}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'See attached.',
      '',
      `--${B}`,
      'Content-Type: application/pdf; name="big.pdf"',
      'Content-Disposition: attachment; filename="big.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(big),
      `--${B}--`,
      '',
    ),
  );
  const msg = parseMessage(raw);
  assert.ok(serializeMessage(msg).equals(raw));
  assert.deepEqual(attachmentsOf(msg), [att('1', 'big.pdf', 'application/pdf', big)]);
  setHeader(msg, 'Subject', 'Big file, and minutes');
  addParts(msg, [parseEntity(NEW_ATTACHMENT)]);
  replaceBody(msg, parseEntity(NEW_TEXT));
  const again = parseMessage(serializeMessage(msg));
  assert.deepEqual(attachmentsOf(again), [att('1', 'big.pdf', 'application/pdf', big), newAttachment('2')]);
});

// ---------------------------------------------------------------------------
// Gaps found when verifying the implementation against this corpus
// ---------------------------------------------------------------------------

/** A multipart/mixed message made of entity texts ("headers CRLF CRLF body", no final line break), with `tail` after the close delimiter. */
function mixedMessage(boundary: string, parts: string[], tail = CRLF): string {
  const head = ['From: a@example.com', 'To: b@example.com', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, ''];
  return crlf(...head, ...parts.flatMap((p) => [`--${boundary}`, p]), `--${boundary}--`) + tail;
}

const textPart = (text: string) => crlf('Content-Type: text/plain; charset=UTF-8', '', text);
const pdfPart = (name: string, content: Buffer) =>
  crlf(`Content-Type: application/pdf; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, 'Content-Transfer-Encoding: base64', '', b64(content));

test('the boundary text inside base64 or text bodies never splits a part, and boundaries are case-sensitive', () => {
  // Gmail's boundaries are hex, so their text can occur in base64 lines; "--" never can (not in the base64 alphabet).
  const encoded = crlf(b64(PDF_REPORT).slice(0, 40) + G1 + 'AAAA', G1, G1 + G1, b64(PDF_REPORT));
  const upper = G1.toUpperCase();
  const text = crlf(
    `Quoting a delimiter mid-line: --${G1} is not one.`,
    G1,
    `-${G1}`,
    `---${G1}`,
    ` --${G1}`,
    `--${G1}x`,
    `--${G1}--x`,
    `--${upper}`,
    `--${upper}--`,
  );
  const pdf = crlf('Content-Type: application/pdf; name="r.pdf"', 'Content-Disposition: attachment; filename="r.pdf"', 'Content-Transfer-Encoding: base64', '', encoded);
  const raw = mixedMessage(G1, [textPart(text), pdf]);
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
  ]);
  assert.equal(msg.parts?.[0]?.body, text);
  assert.equal(msg.parts?.[1]?.body, encoded);
  assert.equal(roundTrip(raw), raw);
  assert.deepEqual(attachmentsOf(msg), [att('1', 'r.pdf', 'application/pdf', Buffer.from(encoded, 'base64'))]);

  const { opens, close } = topParts(raw, G1);
  assert.equal(opens.length, 2, 'only the two real delimiter lines open parts');
  const removed = parseMessage(bytes(raw));
  removeParts(removed, ['1']);
  assert.equal(serialize(removed), raw.slice(0, opens[1]) + raw.slice(close));
  const added = parseMessage(bytes(raw));
  addParts(added, [parseEntity(NEW_ATTACHMENT)]);
  assert.equal(serialize(added), raw.slice(0, close) + `--${G1}${CRLF}${NEW_ATTACHMENT}${CRLF}` + raw.slice(close));
});

test('whatever follows the close delimiter (nothing, line breaks, text) survives round trips and edits', () => {
  const B = 'tail-b';
  for (const tail of ['', CRLF, CRLF + CRLF, CRLF + CRLF + CRLF, CRLF + 'trailing words' + CRLF, CRLF + 'no final line break']) {
    const label = JSON.stringify(tail);
    const raw = mixedMessage(B, [textPart('Hello.'), pdfPart('a.pdf', PDF_SLIDES)], tail);
    assert.equal(roundTrip(raw), raw, label);
    const { opens, close, parts } = topParts(raw, B);

    const added = parseMessage(bytes(raw));
    addParts(added, [parseEntity(NEW_ATTACHMENT)]);
    assert.equal(serialize(added), raw.slice(0, close) + `--${B}${CRLF}${NEW_ATTACHMENT}${CRLF}` + raw.slice(close), label);

    const removed = parseMessage(bytes(raw));
    removeParts(removed, ['1']);
    assert.equal(serialize(removed), raw.slice(0, opens[1]) + raw.slice(close), label);

    const replaced = parseMessage(bytes(raw));
    replaceBody(replaced, parseEntity(NEW_TEXT));
    assert.equal(serialize(replaced), raw.slice(0, parts[0]!.start) + NEW_TEXT + raw.slice(parts[0]!.end), label);
  }

  // A leaf message keeps its last bytes, whatever they are.
  for (const end of ['', CRLF, CRLF + CRLF, ' \t']) {
    const raw = crlf('From: a@example.com', 'Subject: leaf', 'Content-Type: text/plain', '', 'last line') + end;
    const msg = parseMessage(bytes(raw));
    assert.equal(msg.body, 'last line' + end);
    setHeader(msg, 'Subject', 'leaf, edited');
    assert.equal(serialize(msg), raw.replace('Subject: leaf', 'Subject: leaf, edited'), JSON.stringify(end));
  }

  // A new part that ends with a line break keeps it; the delimiter's own CRLF comes after it.
  const raw = mixedMessage(B, [textPart('Hello.')]);
  const msg = parseMessage(bytes(raw));
  addParts(msg, [parseEntity(NEW_ATTACHMENT + CRLF)]);
  const { close } = topParts(raw, B);
  assert.equal(serialize(msg), raw.slice(0, close) + `--${B}${CRLF}${NEW_ATTACHMENT}${CRLF}${CRLF}` + raw.slice(close));
});

test('empty parts (nothing between two delimiter lines, or only the blank line) round-trip and can be edited around', () => {
  const B = 'empty';
  const pdf = pdfPart('a.pdf', PDF_SLIDES);
  const variants: Array<[string, string]> = [
    ['no header fields and no body', crlf(`--${B}`, '', `--${B}`)],
    ['only the blank line', crlf(`--${B}`, '', '', `--${B}`)],
    ['delimiter lines back to back', crlf(`--${B}`, `--${B}`)],
  ];
  for (const [label, start] of variants) {
    const raw = crlf('From: a@example.com', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${B}"`, '', start, pdf, `--${B}--`, '');
    const msg = parseMessage(bytes(raw));
    assert.deepEqual(
      tree(msg),
      [
        ['', 'multipart/mixed'],
        ['0', 'text/plain'],
        ['1', 'application/pdf'],
      ],
      label,
    );
    const empty = msg.parts?.[0];
    assert.deepEqual(empty?.headers, [], label);
    assert.equal(empty?.body, '', label);
    // No attachment disposition and no name: the empty part is the (empty) text of the message.
    assert.equal(bodyEntity(msg), empty, label);
    assert.deepEqual(attachmentsOf(msg), [att('1', 'a.pdf', 'application/pdf', PDF_SLIDES)], label);
    assert.equal(roundTrip(raw), raw, label);

    const { opens, close } = topParts(raw, B);
    const removed = parseMessage(bytes(raw));
    removeParts(removed, ['1']);
    assert.equal(serialize(removed), raw.slice(0, opens[1]) + raw.slice(close), label);
    assert.deepEqual(
      tree(reparse(serialize(removed))),
      [
        ['', 'multipart/mixed'],
        ['0', 'text/plain'],
      ],
      label,
    );

    const added = parseMessage(bytes(raw));
    addParts(added, [parseEntity(NEW_ATTACHMENT)]);
    assert.equal(serialize(added), raw.slice(0, close) + `--${B}${CRLF}${NEW_ATTACHMENT}${CRLF}` + raw.slice(close), label);

    // The empty text is replaced where it was: between the first two delimiter lines.
    const replaced = parseMessage(bytes(raw));
    replaceBody(replaced, parseEntity(NEW_TEXT));
    assert.equal(serialize(replaced), raw.slice(0, opens[0]) + `--${B}${CRLF}${NEW_TEXT}${CRLF}` + raw.slice(opens[1]), label);
    assert.deepEqual(tree(reparse(serialize(replaced))), tree(msg), label);
  }

  // An empty last part, before the close delimiter.
  for (const end of [crlf(`--${B}`, `--${B}--`, ''), crlf(`--${B}`, '', `--${B}--`, '')]) {
    const raw = crlf(`Content-Type: multipart/mixed; boundary="${B}"`, '', `--${B}`, pdf, end);
    const label = JSON.stringify(end);
    const msg = parseMessage(bytes(raw));
    assert.deepEqual(
      tree(msg),
      [
        ['', 'multipart/mixed'],
        ['0', 'application/pdf'],
        ['1', 'text/plain'],
      ],
      label,
    );
    assert.equal(msg.parts?.[1]?.body, '', label);
    assert.equal(bodyEntity(msg)?.partId, '1', label);
    assert.equal(roundTrip(raw), raw, label);
    const { opens } = topParts(raw, B);
    removeParts(msg, ['0']);
    assert.equal(serialize(msg), raw.slice(0, opens[0]) + raw.slice(opens[1]), label);
  }
});

test('a header block without a body: parsing, setHeader, addParts and replaceBody', () => {
  const fields = ['From: a@example.com', 'To: b@example.com', 'Subject: headers only'];
  for (const raw of [crlf(...fields), crlf(...fields, '')]) {
    const label = JSON.stringify(raw.slice(-6));
    const msg = parseMessage(bytes(raw));
    assert.deepEqual(msg.headers, fields, label);
    assert.equal(msg.type, 'text/plain', label);
    assert.equal(msg.body, '', label);
    assert.equal(msg.parts, undefined, label);
    assert.equal(roundTrip(raw), raw, label);
    assert.equal(bodyEntity(msg), msg, label);
    assert.deepEqual(attachmentsOf(msg), [], label);

    // spec reading: the line breaks that end an edited header block are not pinned down;
    // the result must have the edited fields and still no body.
    const edited = parseMessage(bytes(raw));
    setHeader(edited, 'Subject', 'still no body');
    const editedFields = ['From: a@example.com', 'To: b@example.com', 'Subject: still no body'];
    const out = serialize(edited);
    assert.ok(out.startsWith(crlf(...editedFields)), label);
    assert.deepEqual(reparse(out).headers, editedFields, label);
    assert.equal(reparse(out).body, '', label);

    const withFile = parseMessage(bytes(raw));
    addParts(withFile, [parseEntity(NEW_ATTACHMENT)]);
    const expectedTree: Tree = [
      ['', 'multipart/mixed'],
      ['0', 'text/plain'],
      ['1', 'application/pdf'],
    ];
    assert.deepEqual(tree(withFile), expectedTree, label);
    assert.deepEqual(withFile.parts?.[0]?.headers, [], label);
    assert.equal(withFile.parts?.[0]?.body, '', label);
    assert.deepEqual(
      otherFields(withFile.headers).filter((f) => fieldName(f) !== 'mime-version'),
      fields,
      label,
    );
    assert.deepEqual(headerValues(withFile, 'MIME-Version'), ['1.0'], label);
    const reparsed = reparse(serialize(withFile));
    assert.deepEqual(tree(reparsed), expectedTree, label);
    assert.equal(reparsed.parts?.[0]?.body, '', label);
    assert.equal(bodyEntity(reparsed)?.partId, '0', label);
    assert.deepEqual(attachmentsOf(reparsed), [newAttachment('1')], label);

    const withText = parseMessage(bytes(raw));
    replaceBody(withText, parseEntity(NEW_TEXT));
    assert.deepEqual(otherFields(withText.headers), fields, label);
    assert.deepEqual(contentFields(withText.headers), splitHead(NEW_TEXT).fields, label);
    assert.equal(reparse(serialize(withText)).body, splitHead(NEW_TEXT).tail.slice(2), label);
  }

  // The same inside a multipart: a last part with header fields and no blank line.
  const B = 'hdr';
  const raw = crlf(
    `Content-Type: multipart/mixed; boundary="${B}"`,
    '',
    `--${B}`,
    textPart('Hi.'),
    `--${B}`,
    'Content-Type: text/plain; name="empty.txt"',
    'Content-Disposition: attachment; filename="empty.txt"',
    `--${B}--`,
    '',
  );
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(msg.parts?.[1]?.headers, ['Content-Type: text/plain; name="empty.txt"', 'Content-Disposition: attachment; filename="empty.txt"']);
  assert.equal(msg.parts?.[1]?.body, '');
  assert.equal(roundTrip(raw), raw);
  assert.deepEqual(attachmentsOf(msg), [att('1', 'empty.txt', 'text/plain', 0)]);
  const { opens, close } = topParts(raw, B);
  removeParts(msg, ['1']);
  assert.equal(serialize(msg), raw.slice(0, opens[1]) + raw.slice(close));

  // A new part given without a blank line is written exactly as given.
  const blank = crlf('Content-Type: text/plain; name="blank.txt"', 'Content-Disposition: attachment; filename="blank.txt"');
  const added = parseMessage(bytes(raw));
  addParts(added, [parseEntity(blank)]);
  assert.equal(serialize(added), raw.slice(0, close) + `--${B}${CRLF}${blank}${CRLF}` + raw.slice(close));
  assert.deepEqual(attachmentsOf(reparse(serialize(added))).at(-1), att('2', 'blank.txt', 'text/plain', 0));
});

test('thousands of parts: ids, round trip, removing and adding many at once', { timeout: 60_000 }, () => {
  const B = 'many';
  const N = 3000;
  const file = (i: number) => crlf(`Content-Type: text/plain; name="f${i}.txt"`, `Content-Disposition: attachment; filename="f${i}.txt"`, '', `file ${i}`);
  const build = (files: number[], extra: string[] = []) => mixedMessage(B, [textPart('Many files.'), ...files.map(file), ...extra]);
  const all = Array.from({ length: N }, (_, i) => i + 1);
  const raw = build(all);
  const msg = parseMessage(bytes(raw));
  assert.equal(msg.parts?.length, N + 1);
  assert.equal(msg.parts?.at(-1)?.partId, String(N));
  assert.equal(serialize(msg), raw);
  const listed = attachmentsOf(msg);
  assert.equal(listed.length, N);
  assert.deepEqual(listed.at(-1), att(String(N), `f${N}.txt`, 'text/plain', `file ${N}`.length));

  // Every odd file in one call.
  const odd = all.filter((i) => i % 2 === 1);
  const even = all.filter((i) => i % 2 === 0);
  const removed = removeParts(msg, odd.map(String));
  assert.equal(removed.length, odd.length);
  assert.equal(serialize(msg), build(even));
  assert.deepEqual(
    attachmentsOf(msg).map((a) => [a.partId, a.filename]),
    even.map((i, k) => [String(k + 1), `f${i}.txt`]),
  );

  // A thousand new files in one call.
  const extra = Array.from({ length: 1000 }, (_, i) => file(N + 1 + i));
  addParts(
    msg,
    extra.map((t) => parseEntity(t)),
  );
  const out = serialize(msg);
  assert.equal(out, build(even, extra));
  assert.equal(msg.parts?.at(-1)?.partId, String(even.length + extra.length));
  assert.deepEqual(tree(reparse(out)), tree(msg));
});

test('removing a part renumbers the later parts and everything inside them', () => {
  const B = 'outer';
  const I = 'inner';
  const inner = (...parts: string[]) => crlf(`Content-Type: multipart/mixed; boundary="${I}"`, '', ...parts.flatMap((p) => [`--${I}`, p]), `--${I}--`);
  const raw = mixedMessage(B, [textPart('Four files.'), pdfPart('a.pdf', PDF_OVERVIEW), inner(pdfPart('b.pdf', PDF_SLIDES), pdfPart('c.pdf', PDF_CUT)), pdfPart('d.pdf', PDF_MINUTES)]);
  const msg = parseMessage(bytes(raw));
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
    ['2', 'multipart/mixed'],
    ['2.0', 'application/pdf'],
    ['2.1', 'application/pdf'],
    ['3', 'application/pdf'],
  ]);
  removeParts(msg, ['1']);
  assert.deepEqual(tree(msg), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'multipart/mixed'],
    ['1.0', 'application/pdf'],
    ['1.1', 'application/pdf'],
    ['2', 'application/pdf'],
  ]);
  assert.deepEqual(attachmentsOf(msg), [
    att('1.0', 'b.pdf', 'application/pdf', PDF_SLIDES),
    att('1.1', 'c.pdf', 'application/pdf', PDF_CUT),
    att('2', 'd.pdf', 'application/pdf', PDF_MINUTES),
  ]);
  // Later edits address parts by their new ids.
  assert.equal(removeParts(msg, ['1.1'])[0]?.body, b64(PDF_CUT));
  assert.equal(removeParts(msg, ['2'])[0]?.body, b64(PDF_MINUTES));
  assert.equal(serialize(msg), mixedMessage(B, [textPart('Four files.'), inner(pdfPart('b.pdf', PDF_SLIDES))]));
  assert.deepEqual(tree(reparse(serialize(msg))), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'multipart/mixed'],
    ['1.0', 'application/pdf'],
  ]);
});

test("new content that contains the message's own delimiter lines still parses back as the parts that were added", () => {
  // Attaching the draft to itself (forwarding it as message/rfc822) puts G4's delimiter lines inside the new part.
  const text = textOf(gmailAttachments);
  const msg = parseMessage(gmailAttachments.raw);
  const copy = crlf('Content-Type: message/rfc822; name="draft.eml"', 'Content-Disposition: attachment; filename="draft.eml"', '', text);
  addParts(msg, [parseEntity(copy)]);
  const out = serialize(msg);
  const again = reparse(out);
  const expectedTree: Tree = [...gmailAttachments.tree, ['3', 'message/rfc822']];
  assert.deepEqual(tree(msg), expectedTree);
  assert.deepEqual(tree(again), expectedTree);
  assert.equal(again.parts?.[3]?.body, text, 'the attached copy is carried byte for byte');
  assert.equal(again.parts?.[1]?.body, b64(PDF_CONTRACT));
  assert.deepEqual(attachmentsOf(again), [...gmailAttachments.attachments, att('3', 'draft.eml', 'message/rfc822', text.length)]);
  // spec reading: how the clash is avoided (e.g. a new boundary for the message) is left to the
  // implementation; every header field other than Content-* stays as it was.
  assert.deepEqual(otherFields(again.headers), otherFields(splitHead(text).fields));
  assert.equal(serialize(again), out);

  // A new text that quotes the delimiter lines of the message it goes into.
  const quoting = parseMessage(gmailAttachments.raw);
  const quote = crlf('The raw draft looked like this:', `--${G4}`, 'Content-Type: text/plain', '', 'x', `--${G4}--`, 'End of quote.');
  replaceBody(quoting, parseEntity(crlf('Content-Type: text/plain; charset=UTF-8', '', quote)));
  const back = reparse(serialize(quoting));
  assert.deepEqual(tree(back), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
    ['1', 'application/pdf'],
    ['2', DOCX],
  ]);
  assert.equal(back.parts?.[0]?.body, quote);
  assert.deepEqual(attachmentsOf(back), gmailAttachments.attachments);
});

test('every corpus message: a chain of edits always serializes to a message that parses back the same', () => {
  const agenda = NEW_ATTACHMENT.replaceAll('minutes.pdf', 'agenda.pdf');
  for (const c of CORPUS) {
    const msg = parseMessage(c.raw);
    const check = (step: string) => {
      const label = `${c.name}: ${step}`;
      assertShape(msg);
      const out = serialize(msg);
      const again = reparse(out);
      assert.deepEqual(tree(again), tree(msg), label);
      assert.equal(serialize(again), out, `${label}: stable`);
      assert.deepEqual(attachmentsOf(again), attachmentsOf(msg), `${label}: attachments`);
      assert.equal(bodyEntity(again)?.partId, bodyEntity(msg)?.partId, `${label}: body`);
    };
    check('parsed');
    setHeader(msg, 'Subject', 'Edited\r\n twice');
    check('setHeader');
    addParts(msg, [parseEntity(NEW_ATTACHMENT), parseEntity(agenda)]);
    check('addParts');
    removeParts(msg, [String((msg.parts?.length ?? 0) - 2)]);
    check('removeParts of the first new part');
    replaceBody(msg, parseEntity(NEW_BODY));
    check('replaceBody');
    replaceBody(msg, parseEntity(NEW_TEXT));
    check('replaceBody again');
    const names = attachmentsOf(msg).map((a) => a.filename);
    assert.equal(names.at(-1), 'agenda.pdf', c.name);
    assert.ok(!names.includes('minutes.pdf'), c.name);
    removeParts(msg, [attachmentsOf(msg).at(-1)!.partId]);
    check('removeParts of the second new part');
    assert.deepEqual(headerValues(msg, 'Subject'), ['Edited twice'], c.name);
    assert.equal(bodyEntity(msg)?.body, splitHead(NEW_TEXT).tail.slice(2), c.name);
  }
});

test('a close delimiter before the first part, or instead of any part, does not break parsing or edits', () => {
  const B = 'cl';
  const early = crlf(`Content-Type: multipart/mixed; boundary="${B}"`, '', `--${B}--`, `--${B}`, textPart('After a stray close delimiter.'), `--${B}--`, '');
  const onlyClose = crlf('From: a@example.com', `Content-Type: multipart/mixed; boundary="${B}"`, '', `--${B}--`, '');
  for (const raw of [early, onlyClose]) {
    assert.equal(roundTrip(raw), raw);
    const msg = parseMessage(bytes(raw));
    addParts(msg, [parseEntity(NEW_ATTACHMENT)]);
    const again = reparse(serialize(msg));
    assert.deepEqual(tree(again), tree(msg));
    assert.deepEqual(attachmentsOf(again).at(-1), newAttachment(String((msg.parts?.length ?? 0) - 1)));
  }
  // RFC 2046: a close delimiter is not a dash-boundary, so before the first "--cl" line it is preamble text.
  assert.deepEqual(tree(parseMessage(bytes(early))), [
    ['', 'multipart/mixed'],
    ['0', 'text/plain'],
  ]);
});
