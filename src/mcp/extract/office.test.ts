import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { extractOfficeText, officeKind, OfficeError } from './office.js';
import { ZipError } from './zip.js';

// ---------------------------------------------------------------------------
// Fixture builders: real (minimal) OOXML packages
// ---------------------------------------------------------------------------

/** Minimal ZIP writer, deflate only (zip.test.ts has one for unusual layouts). */
function zip(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const body = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    const central = Buffer.alloc(46);
    // Same fields in both headers: flags (UTF-8 names), method, CRC, sizes, name length.
    for (const [header, at] of [[local, 6], [central, 8]] as const) {
      header.writeUInt16LE(0x800, at);
      header.writeUInt16LE(8, at + 2);
      header.writeUInt32LE(crc32(data), at + 8);
      header.writeUInt32LE(body.length, at + 12);
      header.writeUInt32LE(data.length, at + 16);
      header.writeUInt16LE(nameBytes.length, at + 20);
    }
    local.writeUInt32LE(0x04034b50, 0);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const count = Object.keys(files).length;
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type Rel = [id: string, type: string, target: string];

function rels(list: Rel[]): string {
  const items = list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`);
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

function contentTypes(overrides: Record<string, string>): string {
  const items = Object.entries(overrides).map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`);
  return (
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    `<Default Extension="xml" ContentType="application/xml"/>${items.join('')}</Types>`
  );
}

// --- Word ---

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  `xmlns:r="${REL}" ` +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" mc:Ignorable="w14"';

const WORD_STYLES =
  `${XML_DECLARATION}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  // French Word: localized style id, built-in English name.
  '<w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>' +
  // A custom style based on Heading 1 is a heading too.
  '<w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My Heading"/><w:basedOn w:val="Heading1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style>' +
  '<w:style w:type="character" w:styleId="Heading1Char"><w:name w:val="Heading 1 Char"/></w:style>' +
  '</w:styles>';

function docx(body: string, options: { documentPath?: string; styles?: string | null } = {}): Buffer {
  const path = options.documentPath ?? 'word/document.xml';
  const slash = path.lastIndexOf('/');
  const files: Record<string, string> = {
    '[Content_Types].xml': contentTypes({
      [`/${path}`]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      '/word/styles.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    }),
    '_rels/.rels': rels([['rId1', 'officeDocument', path]]),
    [path]: `${XML_DECLARATION}<w:document ${W_NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  };
  if (options.styles !== null) {
    files[`${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`] = rels([['rId1', 'styles', 'styles.xml']]);
    files['word/styles.xml'] = options.styles ?? WORD_STYLES;
  }
  return zip(files);
}

const run = (text: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (content: string, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
const style = (id: string) => `<w:pStyle w:val="${id}"/>`;
const numbering = (level: number, id = 3) => `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr>`;
const cell = (content: string, properties = '') => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ''}${content}</w:tc>`;

const readWord = (data: Buffer) => extractOfficeText(data, 'docx');

// --- Excel ---

const S_NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"`;

interface SheetSpec {
  name: string;
  /** Content of <sheetData>. */
  rows: string;
  state?: string;
  /** ZIP entry of the sheet part (default xl/worksheets/sheetN.xml). */
  path?: string;
  /** Target written in the workbook's relationships (default: relative to xl/). */
  target?: string;
  type?: string;
}

function xlsx(sheets: SheetSpec[], options: { strings?: string[]; styles?: string; workbookPr?: string } = {}): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': contentTypes({ '/xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
  };
  const workbookRels: Rel[] = [];
  const sheetElements = sheets.map((sheet, i) => {
    const path = sheet.path ?? `xl/worksheets/sheet${i + 1}.xml`;
    workbookRels.push([`rId${i + 10}`, sheet.type ?? 'worksheet', sheet.target ?? path.slice('xl/'.length)]);
    files[path] = `${XML_DECLARATION}<worksheet ${S_NS}><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${sheet.rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
    return `<sheet name="${sheet.name}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${i + 10}"/>`;
  });
  if (options.strings) {
    workbookRels.push(['rId2', 'sharedStrings', 'sharedStrings.xml']);
    files['xl/sharedStrings.xml'] = `${XML_DECLARATION}<sst ${S_NS} count="${options.strings.length}" uniqueCount="${options.strings.length}">${options.strings.map((s) => `<si>${s}</si>`).join('')}</sst>`;
  }
  if (options.styles) {
    workbookRels.push(['rId3', 'styles', 'styles.xml']);
    files['xl/styles.xml'] = `${XML_DECLARATION}<styleSheet ${S_NS}>${options.styles}</styleSheet>`;
  }
  files['xl/workbook.xml'] = `${XML_DECLARATION}<workbook ${S_NS}>${options.workbookPr ?? '<workbookPr defaultThemeVersion="164011"/>'}<bookViews><workbookView/></bookViews><sheets>${sheetElements.join('')}</sheets><calcPr calcId="191029"/></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = rels(workbookRels);
  return zip(files);
}

/** A row of numeric cells in columns A, B, …; undefined leaves a column out. */
const numbers = (r: number, values: (number | undefined)[], s = 0) =>
  `<row r="${r}">${values.map((v, i) => (v === undefined ? '' : `<c r="${String.fromCharCode(65 + i)}${r}" s="${s}"><v>${v}</v></c>`)).join('')}</row>`;

// --- PowerPoint ---

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  `xmlns:r="${REL}" ` +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const textRun = (text: string) => `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text}</a:t></a:r>`;
const paragraph = (content: string) => `<a:p>${content}<a:endParaRPr lang="en-US"/></a:p>`;
const shape = (paragraphs: string, placeholder = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
const tree = (shapes: string) =>
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>`;
const slideXml = (shapes: string, attributes = '') => `${XML_DECLARATION}<p:sld ${P_NS}${attributes}>${tree(shapes)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
const notesXml = (shapes: string) => `${XML_DECLARATION}<p:notes ${P_NS}>${tree(shapes)}</p:notes>`;

interface SlideSpec {
  /** File number: ppt/slides/slide<file>.xml */
  file: number;
  xml: string;
  notes?: string;
}

/** Slides are listed in <p:sldIdLst> in array order; `withSlideList: false` leaves the presentation without relationships. */
function pptx(slides: SlideSpec[], options: { withSlideList?: boolean } = {}): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': contentTypes({ '/ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
  };
  const presentationRels: Rel[] = [['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml']];
  const ids = slides.map((slide, i) => {
    files[`ppt/slides/slide${slide.file}.xml`] = slide.xml;
    presentationRels.push([`rId${i + 10}`, 'slide', `slides/slide${slide.file}.xml`]);
    const slideRels: Rel[] = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    if (slide.notes) {
      files[`ppt/notesSlides/notesSlide${slide.file}.xml`] = slide.notes;
      slideRels.push(['rId2', 'notesSlide', `../notesSlides/notesSlide${slide.file}.xml`]);
    }
    files[`ppt/slides/_rels/slide${slide.file}.xml.rels`] = rels(slideRels);
    return `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`;
  });
  files['ppt/presentation.xml'] = `${XML_DECLARATION}<p:presentation ${P_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids.join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;
  if (options.withSlideList !== false) files['ppt/_rels/presentation.xml.rels'] = rels(presentationRels);
  return zip(files);
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

test('docx: headings (also localized and inherited), lists, runs, tabs, breaks and entities', () => {
  const body = [
    para(run('Quarterly report'), style('Title')),
    para(run('Overview'), style('Heading1')),
    para(run('Détails'), style('Titre2')),
    para(run('Custom'), style('MyHeading')),
    para(run('Numbered heading'), style('Heading1') + numbering(0)),
    para(run('outline three'), '<w:outlineLvl w:val="2"/>'),
    para(run('Plain') + run(' text') + '<w:proofErr w:type="spellStart"/>'),
    // The pPr's <w:tabs> holds tab stops, not tab characters.
    para('<w:r><w:t>Tab</w:t><w:tab/><w:t>stop</w:t></w:r>', '<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>'),
    para('<w:r><w:t>line one</w:t><w:br/><w:t>line two</w:t><w:cr/><w:t>three</w:t></w:r>'),
    para('<w:r><w:t>well</w:t><w:noBreakHyphen/><w:t>known</w:t></w:r>'),
    para(run('Fish &amp; chips &lt;3 &#x41;&#233; &quot;q&quot; &apos;a&apos; &#128512;')),
    para(run('   indented')),
    para(run('first'), numbering(0)),
    para(run('nested'), numbering(1)),
    para(run('bullet from the style'), style('ListBullet')),
    para(run('numbering switched off'), style('ListBullet') + '<w:numPr><w:numId w:val="0"/></w:numPr>'),
    para(''),
    '<w:p/>',
    para(run(' ')),
    para(run('after blanks')),
  ].join('');
  const result = readWord(docx(body));
  assert.equal(result.format, 'text/markdown');
  assert.equal(result.note, undefined);
  assert.equal(
    result.text,
    [
      '# Quarterly report',
      '# Overview',
      '## Détails',
      '# Custom',
      '# Numbered heading',
      '### outline three',
      'Plain text',
      'Tab\tstop',
      'line one',
      'line two',
      'three',
      'well-known',
      `Fish & chips <3 Aé "q" 'a' 😀`,
      '   indented',
      '- first',
      '  - nested',
      '- bullet from the style',
      'numbering switched off',
      '',
      'after blanks',
    ].join('\n'),
  );
});

test('docx: leaves out deleted text, field codes, duplicate text box copies and phonetic guides', () => {
  const textBox = (text: string) => `<w:txbxContent>${para(run(text))}</w:txbxContent>`;
  const body = [
    para(run('Kept ') + `<w:del w:id="1" w:author="A"><w:r><w:delText>deleted </w:delText><w:tab/></w:r></w:del>` + `<w:ins w:id="2" w:author="A">${run('inserted')}</w:ins>`),
    para(
      run('Page ') +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ),
    para('<w:fldSimple w:instr=" DATE \\@ &quot;yyyy-MM-dd&quot; "><w:r><w:t>2026-09-23</w:t></w:r></w:fldSimple>'),
    para(
      run('Before box') +
        `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx>${textBox('In the box')}</wps:txbx></w:drawing></mc:Choice>` +
        `<mc:Fallback><w:pict><v:shape><v:textbox>${textBox('In the box')}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>` +
        run(' after box'),
    ),
    para('<w:moveFrom w:id="3" w:author="A"><w:r><w:t>old place</w:t></w:r></w:moveFrom><w:moveTo w:id="4" w:author="A"><w:r><w:t>new place</w:t></w:r></w:moveTo>'),
    para(run('Restyled'), `${style('Heading1')}<w:pPrChange w:id="5" w:author="A"><w:pPr>${style('Normal')}${numbering(0)}</w:pPr></w:pPrChange>`),
    para('<w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>かん</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>漢</w:t></w:r></w:rubyBase></w:ruby></w:r>'),
    para('<m:oMathPara><m:oMath><m:r><m:t>x=2</m:t></m:r></m:oMath></m:oMathPara>'),
    para('<!-- <w:r><w:t>commented out</w:t></w:r> --><w:r><w:t><![CDATA[a < b & c]]></w:t></w:r>'),
    `<w:sdt><w:sdtPr><w:alias w:val="Client"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>${para(run('Content control'))}</w:sdtContent></w:sdt>`,
  ].join('');
  assert.equal(
    readWord(docx(body)).text,
    ['Kept inserted', 'Page 7', '2026-09-23', 'In the box', 'Before box after box', 'new place', '# Restyled', '漢', 'x=2', 'a < b & c', 'Content control'].join('\n'),
  );
});

test('docx: tables become pipe tables; merged cells, nested tables and pipes are handled', () => {
  const table =
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
    `<w:tr>${cell(para(run('Name')), '<w:tcW w:w="3000"/>')}${cell(para(run('Notes')))}${cell(para(run('Qty')))}</w:tr>` +
    `<w:tr>${cell(para(run('Alice')))}${cell(para(run('two')) + para(run('paragraphs')))}${cell(para(run('3')))}</w:tr>` +
    `<w:tr>${cell(para(run('Merged | cell')), '<w:gridSpan w:val="2"/>')}${cell(para(run('4')))}</w:tr>` +
    `<w:tr>${cell(para(run('Outer')) + `<w:tbl><w:tr>${cell(para(run('inner a')))}${cell(para(run('inner b')))}</w:tr></w:tbl>`)}` +
    `${cell(para('<w:r><w:t>line</w:t><w:br/><w:t>break</w:t></w:r>'))}${cell(para(''))}</w:tr>` +
    '</w:tbl>';
  const body = para(run('Before table')) + table + para(run('After table'));
  assert.equal(
    readWord(docx(body)).text,
    [
      'Before table',
      '',
      '| Name | Notes | Qty |',
      '| --- | --- | --- |',
      '| Alice | two paragraphs | 3 |',
      '| Merged \\| cell |  | 4 |',
      '| Outer inner a inner b | line break |  |',
      '',
      'After table',
    ].join('\n'),
  );
});

test('docx: finds the main part through _rels/.rels and reads heading style ids without styles.xml', () => {
  const body = para(run('Section'), style('Heading2')) + para(run('Body'));
  assert.equal(readWord(docx(body, { documentPath: 'word/document2.xml', styles: null })).text, '## Section\nBody');
});

test('docx: an empty document gives empty text', () => {
  assert.equal(readWord(docx('')).text, '');
});

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

test('xlsx: cell types, positions from references, trimming and CSV quoting', () => {
  const strings = [
    '<t>Name</t>',
    // Rich text runs are joined; the phonetic guide (furigana) is left out.
    '<r><rPr><b/></rPr><t>Rich</t></r><r><t xml:space="preserve"> text</t></r><rPh sb="0" eb="4"><t>リッチ</t></rPh><phoneticPr fontId="1"/>',
    '<t>a,b "c"</t>',
    '<t>line1_x000D_\nline2</t>',
    '<t>Fish &amp; chips _x005F_x0041_</t>',
  ];
  const rows =
    '<row r="1" spans="1:2"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>inline</t></is></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="b"><v>0</v></c><c r="D2" t="e"><v>#DIV/0!</v></c></row>' +
    // Formula with a cached value, formula with a text result, formula never calculated, float noise, exponent.
    '<row r="3"><c r="A3"><f>1+2</f><v>3</v></c><c r="B3" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c r="C3"><f>A3*2</f></c><c r="D3"><v>0.30000000000000004</v></c><c r="E3"><v>-1.5E-3</v></c></row>' +
    // Row 4 is missing; columns A, C and D are empty.
    '<row r="5"><c r="B5" t="s"><v>2</v></c><c r="E5"><v>1234567</v></c></row>' +
    // Trailing empty cells (formatted, or pointing at a missing string) are dropped.
    '<row r="6"><c r="A6" t="s"><v>3</v></c><c r="B6" s="1"/><c r="C6" t="s"><v>99</v></c></row>' +
    '<row r="7"><c r="A7" t="s"><v>4</v></c></row>' +
    // Trailing empty rows are dropped.
    '<row r="8"><c r="A8" s="1"/></row><row r="10" spans="1:3" ht="15"/>';
  const result = extractOfficeText(xlsx([{ name: 'Types', rows }], { strings }), 'xlsx');
  assert.equal(result.format, 'text/csv');
  assert.equal(result.note, undefined);
  assert.equal(
    result.text,
    ['## Sheet: Types', 'Name,Rich text', 'inline,TRUE,FALSE,#DIV/0!', '3,xy,,0.3,-0.0015', '', ',"a,b ""c""",,,1234567', '"line1\r\nline2"', 'Fish & chips _x0041_'].join('\n'),
  );
});

test('xlsx: cells without a reference follow the previous cell, rows without a number the previous row', () => {
  const rows = '<row><c t="inlineStr"><is><t>a</t></is></c><c r="C1"><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>';
  assert.equal(extractOfficeText(xlsx([{ name: 'S', rows }]), 'xlsx').text, '## Sheet: S\na,,1,2\n3');
});

test('xlsx: namespace prefixes on SpreadsheetML elements are accepted', () => {
  // The Open XML SDK can write every element with an x: prefix.
  const files = {
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><x:sheets><x:sheet name="P" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'sharedStrings', 'sharedStrings.xml']]),
    'xl/sharedStrings.xml': '<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:si><x:t>prefixed</x:t></x:si></x:sst>',
    'xl/worksheets/sheet1.xml':
      '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>',
  };
  assert.equal(extractOfficeText(zip(files), 'xlsx').text, '## Sheet: P\nprefixed,2');
});

const DATE_STYLES =
  '<numFmts count="7">' +
  '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
  '<numFmt numFmtId="165" formatCode="[$-409]m/d/yy\\ h:mm\\ AM/PM;@"/>' +
  '<numFmt numFmtId="166" formatCode="0.00&quot; days&quot;"/>' +
  '<numFmt numFmtId="167" formatCode="[h]:mm"/>' +
  '<numFmt numFmtId="168" formatCode="h:mm:ss"/>' +
  '<numFmt numFmtId="169" formatCode="[Red]#,##0.00_);\\(#,##0.00\\)"/>' +
  '<numFmt numFmtId="170" formatCode="mmm yyyy"/>' +
  '</numFmts>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="11">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0 General
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 1 built-in date
  '<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 2 built-in date and time
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 3 custom date
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment horizontal="left"/></xf>' + // 4 custom date and time
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 5 "days" is quoted: a number
  '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 6 elapsed time
  '<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 7 custom time
  '<xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 8 brackets and escapes: a number
  '<xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 9 built-in time h:mm
  '<xf numFmtId="170" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 10 month and year
  '</cellXfs>';

test('xlsx: dates, times and durations in the 1900 date system', () => {
  const cells: [number, number, string][] = [
    [45000, 1, '2023-03-15'],
    [45000.5, 2, '2023-03-15T12:00'],
    [45000, 3, '2023-03-15'],
    [45000.75, 4, '2023-03-15T18:00'],
    [2.5, 5, '2.5'],
    [1.5, 6, '36:00'],
    [0.75, 7, '18:00'],
    [1234.5, 8, '1234.5'],
    [0.5, 9, '12:00'],
    [45000.25, 7, '06:00'],
    [45000, 10, '2023-03-15'],
    [45000.000011574, 2, '2023-03-15T00:00:01'],
    [1, 1, '1900-01-01'],
    [59, 1, '1900-02-28'],
    [60, 1, '1900-02-29'], // Lotus 1-2-3's leap day
    [61, 1, '1900-03-01'],
    [2958465, 1, '9999-12-31'],
    [2958465.999999, 2, '2958465.999999'], // rounds into the year 10000: shown as a number
    [-1, 1, '-1'], // before the epoch: shown as a number
    [45000, 0, '45000'],
  ];
  const rows = cells.map(([value, s], i) => numbers(i + 1, [value], s)).join('');
  const lines = extractOfficeText(xlsx([{ name: 'Dates', rows }], { styles: DATE_STYLES }), 'xlsx').text.split('\n');
  assert.deepEqual(lines, ['## Sheet: Dates', ...cells.map(([, , expected]) => expected)]);
});

test('xlsx: dates in the 1904 date system', () => {
  const rows = numbers(1, [45000], 1) + numbers(2, [45000.5], 2) + numbers(3, [0], 1) + numbers(4, [60], 1);
  for (const workbookPr of ['<workbookPr date1904="1"/>', "<workbookPr date1904='true' defaultThemeVersion='124226'/>"]) {
    const text = extractOfficeText(xlsx([{ name: 'Mac', rows }], { styles: DATE_STYLES, workbookPr }), 'xlsx').text;
    assert.equal(text, '## Sheet: Mac\n2027-03-16\n2027-03-16T12:00\n1904-01-01\n1904-03-01');
  }
});

test('xlsx: sheets in workbook order, absolute and relative targets, hidden sheets, chart sheets skipped', () => {
  const one = (text: string) => `<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row>`;
  const data = xlsx([
    { name: 'Summary', rows: one('from sheet2.xml'), path: 'xl/worksheets/sheet2.xml', target: '/xl/worksheets/sheet2.xml' },
    { name: 'Data &amp; more', rows: one('from sheet1.xml'), path: 'xl/worksheets/sheet1.xml' },
    { name: 'Chart', rows: '', path: 'xl/chartsheets/sheet1.xml', type: 'chartsheet' },
    { name: 'Secret', rows: one('hidden value'), state: 'hidden', path: 'xl/worksheets/sheet3.xml', target: './worksheets/../worksheets/sheet3.xml' },
    { name: 'Very', rows: one('very hidden'), state: 'veryHidden', path: 'xl/worksheets/sheet5.xml' },
    { name: 'Empty', rows: '', path: 'xl/worksheets/sheet4.xml' },
  ]);
  assert.equal(
    extractOfficeText(data, 'xlsx').text,
    [
      '## Sheet: Summary',
      'from sheet2.xml',
      '',
      '## Sheet: Data & more',
      'from sheet1.xml',
      '',
      '## Sheet: Secret (hidden)',
      'hidden value',
      '',
      '## Sheet: Very (hidden)',
      'very hidden',
      '',
      '## Sheet: Empty',
    ].join('\n'),
  );
});

test('xlsx: stops at 200,000 cells and says where', () => {
  const row = '<row>' + '<c><v>1</v></c>'.repeat(100) + '</row>';
  const big = { name: 'Big', rows: row.repeat(2001) };
  const after = { name: 'After', rows: numbers(1, [1]) };
  const result = extractOfficeText(xlsx([big, after]), 'xlsx');
  const lines = result.text.split('\n');
  assert.equal(lines.length, 1 + 2000, 'heading and 2,000 rows of 100 cells');
  assert.equal(lines[2000], Array(100).fill('1').join(','));
  assert.equal(result.note, 'The output stops at 200000 cells: sheet "Big" is cut before row 2001. Sheets left out: "After".');
});

test('xlsx: long runs of empty rows are shortened, with a note', () => {
  const rows = numbers(1, [1]) + numbers(5002, [2]) + numbers(5003, [3]);
  const result = extractOfficeText(xlsx([{ name: 'Sparse', rows }]), 'xlsx');
  assert.deepEqual(result.text.split('\n'), ['## Sheet: Sparse', '1', ...Array<string>(1000).fill(''), '2', '3']);
  assert.match(result.note ?? '', /In sheet "Sparse", runs of more than 1000 empty rows were shortened/);
});

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

test('pptx: slides in presentation order with notes, line breaks, tables; slide numbers and empty paragraphs left out', () => {
  const slideNumber = shape(paragraph('<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>1</a:t></a:fld>'), 'sldNum');
  const first = slideXml(
    shape(paragraph(textRun('First slide')), 'title') +
      shape(paragraph(textRun('Line one') + '<a:br><a:rPr lang="en-US"/></a:br>' + textRun('Line two')) + '<a:p><a:endParaRPr lang="en-US"/></a:p>' + paragraph(textRun('  '))) +
      slideNumber,
  );
  const notes = notesXml(
    shape('', 'sldImg') + shape(paragraph(textRun('Say hello')) + paragraph(textRun('Then &amp; after'))) + slideNumber,
  );
  const table =
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="100"/><a:gridCol w="100"/></a:tblGrid>' +
    `<a:tr h="100"><a:tc><a:txBody><a:bodyPr/>${paragraph(textRun('Cell A'))}</a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/>${paragraph(textRun('Cell B'))}</a:txBody></a:tc></a:tr>` +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const alternate =
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    `<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">${shape(paragraph(textRun('Once only')))}</mc:Choice>` +
    `<mc:Fallback>${shape(paragraph(textRun('Once only')))}</mc:Fallback></mc:AlternateContent>`;
  const second = slideXml(shape(paragraph(textRun('Second slide')), 'title') + table + alternate + slideNumber);
  const hidden = slideXml(shape(paragraph(textRun('Hidden text'))), ' show="0"');

  // File names disagree with the presentation order on purpose.
  const data = pptx([
    { file: 2, xml: first, notes },
    { file: 1, xml: second },
    { file: 3, xml: hidden },
  ]);
  const result = extractOfficeText(data, 'pptx');
  assert.equal(result.format, 'text/markdown');
  assert.equal(
    result.text,
    [
      '## Slide 1',
      'First slide',
      'Line one\nLine two',
      'Notes: Say hello\nThen & after',
      '',
      '## Slide 2',
      'Second slide',
      'Cell A',
      'Cell B',
      'Once only',
      '',
      '## Slide 3 (hidden)',
      'Hidden text',
    ].join('\n'),
  );
});

test('pptx: without a usable slide list, slides are taken by file name in natural order', () => {
  const slides = [10, 2, 1].map((file) => ({ file, xml: slideXml(shape(paragraph(textRun(`file ${file}`)))) }));
  const text = extractOfficeText(pptx(slides, { withSlideList: false }), 'pptx').text;
  assert.equal(text, '## Slide 1\nfile 1\n\n## Slide 2\nfile 2\n\n## Slide 3\nfile 10');
});

// ---------------------------------------------------------------------------
// Detection and errors
// ---------------------------------------------------------------------------

test('officeKind detects by MIME type first, then by file name', () => {
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', undefined), 'docx');
  assert.equal(officeKind('application/vnd.ms-word.document.macroEnabled.12', undefined), 'docx');
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="a.xlsx"', undefined), 'xlsx');
  assert.equal(officeKind('APPLICATION/VND.MS-EXCEL.SHEET.MACROENABLED.12', undefined), 'xlsx');
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'x.bin'), 'pptx');
  assert.equal(officeKind('application/vnd.ms-powerpoint.presentation.macroEnabled.12', undefined), 'pptx');
  assert.equal(officeKind('application/octet-stream', 'Report Q3.DOCX'), 'docx');
  assert.equal(officeKind(undefined, 'model.xlsm'), 'xlsx');
  assert.equal(officeKind('', 'deck.pptm'), 'pptx');
  assert.equal(officeKind(undefined, 'budget.xlsx '), 'xlsx');
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.presentationml.slideshow', undefined), 'pptx');
  assert.equal(officeKind('application/vnd.openxmlformats-officedocument.wordprocessingml.template', undefined), 'docx');
  assert.equal(officeKind(undefined, 'Letter.dotx'), 'docx');
  assert.equal(officeKind(undefined, 'Budget.xltm'), 'xlsx');
  assert.equal(officeKind(undefined, 'Talk.ppsx'), 'pptx');
  assert.equal(officeKind('application/msword', 'old.doc'), undefined);
  assert.equal(officeKind('application/vnd.ms-excel', 'old.xls'), undefined);
  assert.equal(officeKind('application/vnd.google-apps.document', 'Doc'), undefined);
  assert.equal(officeKind('application/pdf', 'file.pdf'), undefined);
  assert.equal(officeKind(undefined, 'docx'), undefined);
  assert.equal(officeKind(undefined, undefined), undefined);
});

test('refuses files of the wrong kind, damaged files and legacy or encrypted Office files', () => {
  const word = docx(para(run('text')));
  const excel = xlsx([{ name: 'S', rows: '' }]);
  const powerpoint = pptx([]);
  assert.throws(() => extractOfficeText(excel, 'docx'), (err) => err instanceof OfficeError && err.message === 'Not a Word document');
  assert.throws(() => extractOfficeText(word, 'xlsx'), (err) => err instanceof OfficeError && err.message === 'Not an Excel workbook');
  assert.throws(() => extractOfficeText(word, 'pptx'), (err) => err instanceof OfficeError && err.message === 'Not a PowerPoint presentation');
  assert.throws(() => extractOfficeText(powerpoint, 'docx'), /Not a Word document/);
  assert.throws(() => extractOfficeText(zip({}), 'xlsx'), /Not an Excel workbook/);
  assert.throws(() => extractOfficeText(zip({ 'word/document.xml': 'not xml at all' }), 'docx'), /Not a Word document/);
  assert.equal(extractOfficeText(powerpoint, 'pptx').text, '', 'a presentation without slides');

  assert.throws(() => extractOfficeText(Buffer.from('%PDF-1.7 not a zip'), 'docx'), ZipError);
  assert.throws(() => extractOfficeText(word.subarray(0, word.length - 30), 'docx'), ZipError);

  const ole = Buffer.alloc(1024);
  ole.writeUInt32BE(0xd0cf11e0, 0);
  ole.writeUInt32BE(0xa1b11ae1, 4);
  assert.throws(() => extractOfficeText(ole, 'docx'), /older binary Office format/);
  Buffer.from('EncryptedPackage', 'utf16le').copy(ole, 512);
  assert.throws(() => extractOfficeText(ole, 'xlsx'), (err) => err instanceof OfficeError && /password-protected/.test(err.message));
});

test('accepts a plain Uint8Array as well as a Buffer', () => {
  const word = docx(para(run('from bytes')));
  const bytes = new Uint8Array(word.length + 8).subarray(4, 4 + word.length);
  bytes.set(word);
  assert.equal(extractOfficeText(bytes, 'docx').text, 'from bytes');
});
