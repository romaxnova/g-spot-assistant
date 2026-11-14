import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { openZip, ZipError } from './zip.js';

// ---------------------------------------------------------------------------
// A tiny ZIP writer for fixtures, able to produce the layouts real writers use
// ---------------------------------------------------------------------------

interface FixtureEntry {
  name: string;
  data: string | Buffer;
  /** 0 stored, 8 deflate (default); anything else is written as stored bytes under that method number. */
  method?: number;
  /** Extra general purpose flags (bit 11, UTF-8 names, is always set unless latin1Name). */
  flags?: number;
  /** Streaming style: zero CRC and sizes in the local header, the real ones in a data descriptor after the data. */
  dataDescriptor?: boolean;
  /** Extra field present only in the local header, so local and central lengths differ. */
  localExtra?: Buffer;
  /** Declared uncompressed size, when it should lie. */
  declaredSize?: number;
  /** Declared CRC, when it should lie. */
  declaredCrc?: number;
  /** Name bytes in Latin-1 without the UTF-8 flag. */
  latin1Name?: boolean;
}

function makeZip(entries: FixtureEntry[], comment: string | Buffer = ''): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const content = Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(content) : content;
    const name = Buffer.from(e.name, e.latin1Name ? 'latin1' : 'utf8');
    const flags = (e.flags ?? 0) | (e.latin1Name ? 0 : 0x800) | (e.dataDescriptor ? 0x8 : 0);
    const crc = e.declaredCrc ?? crc32(content);
    const size = e.declaredSize ?? content.length;
    const localExtra = e.localExtra ?? Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!e.dataDescriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, body);
    let written = local.length + name.length + localExtra.length + body.length;
    if (e.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(size, 12);
      parts.push(descriptor);
      written += descriptor.length;
    }

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += written;
  }
  const directory = Buffer.concat(central);
  const commentBytes = Buffer.from(comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...parts, directory, end, commentBytes]);
}

/** Offset of the end-of-central-directory record in an archive without a comment. */
const endRecord = (zip: Buffer) => zip.length - 22;

// ---------------------------------------------------------------------------

test('reads stored and deflated entries, in directory order', () => {
  const xml = '<?xml version="1.0"?><root>héllo ✓</root>'.repeat(50);
  const zip = openZip(
    makeZip([
      { name: 'mimetype', data: 'application/test', method: 0 },
      { name: 'word/document.xml', data: xml },
      { name: 'empty.txt', data: '' },
      { name: 'folder/', data: '', method: 0 },
    ]),
  );
  assert.deepEqual(zip.names(), ['mimetype', 'word/document.xml', 'empty.txt', 'folder/']);
  assert.equal(zip.has('word/document.xml'), true);
  assert.equal(zip.has('word/Document.xml'), false, 'names are exact');
  assert.equal(zip.readText('mimetype'), 'application/test');
  assert.equal(zip.readText('word/document.xml'), xml);
  assert.equal(zip.readText('empty.txt'), '');
  assert.equal(zip.read('folder/')?.length, 0);
  assert.equal(zip.read('missing.xml'), undefined);
  assert.equal(zip.readText('missing.xml'), undefined);
});

test('uses central directory sizes when the local header has a data descriptor and zero sizes', () => {
  const zip = openZip(
    makeZip([
      { name: 'a.xml', data: '<a>streamed</a>', dataDescriptor: true },
      { name: 'b.xml', data: 'stored and streamed', method: 0, dataDescriptor: true },
      { name: 'c.xml', data: '<c/>' },
    ]),
  );
  assert.equal(zip.readText('a.xml'), '<a>streamed</a>');
  assert.equal(zip.readText('b.xml'), 'stored and streamed');
  assert.equal(zip.readText('c.xml'), '<c/>');
});

test('finds the data through the local header even when its extra field differs from the central one', () => {
  const zip = openZip(makeZip([{ name: 'x.xml', data: '<x>padded</x>', localExtra: Buffer.from([0xfe, 0xca, 3, 0, 1, 2, 3]) }]));
  assert.equal(zip.readText('x.xml'), '<x>padded</x>');
});

test('finds the end record behind an archive comment, even one containing its signature', () => {
  const entries: FixtureEntry[] = [{ name: 'a.txt', data: 'alpha' }];
  assert.equal(openZip(makeZip(entries, 'Created by a test')).readText('a.txt'), 'alpha');
  // The comment holds a fake end record (describing an empty archive) that would fit before the file's end.
  const tricky = Buffer.concat([Buffer.from('comment with '), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(30)]);
  assert.equal(openZip(makeZip(entries, tricky)).readText('a.txt'), 'alpha');
  assert.equal(openZip(makeZip(entries, 'x'.repeat(65535))).readText('a.txt'), 'alpha', 'longest possible comment');
  // Stray bytes appended after the archive (the comment length no longer reaches the end).
  assert.equal(openZip(Buffer.concat([makeZip(entries), Buffer.alloc(100)])).readText('a.txt'), 'alpha');
});

test('inflates lazily and only once', () => {
  // The second entry is damaged, but nothing notices until it is read.
  const good = makeZip([{ name: 'good.xml', data: '<ok/>' }, { name: 'bad.xml', data: '<bad/>', declaredCrc: 1 }]);
  const zip = openZip(good);
  const first = zip.read('good.xml');
  assert.equal(zip.read('good.xml'), first, 'the same buffer comes back from the cache');
  assert.throws(() => zip.read('bad.xml'), ZipError);
});

test('decodes UTF-8, UTF-16 and CP437/Latin-1 names and texts', () => {
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a>ü</a>', 'utf16le')]);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('<a>ü</a>', 'utf16le').swap16()]);
  const zip = openZip(
    makeZip([
      { name: 'dossier/résumé.xml', data: '\ufeff<a>bom</a>' },
      { name: 'café.txt', data: 'latin', latin1Name: true },
      { name: 'le.xml', data: utf16le },
      { name: 'be.xml', data: utf16be },
    ]),
  );
  assert.deepEqual(zip.names(), ['dossier/résumé.xml', 'café.txt', 'le.xml', 'be.xml']);
  assert.equal(zip.readText('dossier/résumé.xml'), '<a>bom</a>', 'UTF-8 byte-order mark removed');
  assert.equal(zip.readText('café.txt'), 'latin');
  assert.equal(zip.readText('le.xml'), '<a>ü</a>');
  assert.equal(zip.readText('be.xml'), '<a>ü</a>');
});

test('enforces the entry, size and total limits (zip bombs)', () => {
  const big = 'A'.repeat(2 * 1024 * 1024); // deflates to a few kilobytes
  // Honest header: refused from the declared size, before inflating.
  const honest = openZip(makeZip([{ name: 'big.xml', data: big }]), { maxEntryBytes: 1024 * 1024 });
  assert.throws(() => honest.read('big.xml'), /ZIP entry "big.xml" is too large \(2097152 bytes; the limit is 1048576\)/);

  // Lying header: declares 100 bytes but inflates to 2 MiB. Inflation stops at the declared size.
  const liar = openZip(makeZip([{ name: 'bomb.xml', data: big, declaredSize: 100 }]));
  assert.throws(() => liar.read('bomb.xml'), /expands beyond its declared size of 100 bytes/);

  // Total across entries.
  const many = openZip(
    makeZip([
      { name: 'a', data: 'x'.repeat(600) },
      { name: 'b', data: 'y'.repeat(600) },
    ]),
    { maxTotalBytes: 1000 },
  );
  assert.equal(many.read('a')?.length, 600);
  assert.equal(many.read('a')?.length, 600, 'a cached entry does not count twice');
  assert.throws(() => many.read('b'), /expands to more than 1000 bytes/);

  // Entry count.
  const three = makeZip([
    { name: '1', data: '' },
    { name: '2', data: '' },
    { name: '3', data: '' },
  ]);
  assert.throws(() => openZip(three, { maxEntries: 2 }), /has 3 entries; the limit is 2/);
  assert.equal(openZip(three, { maxEntries: 3 }).names().length, 3);
});

test('rejects input that is not a ZIP archive or is damaged', () => {
  const random = Buffer.alloc(4096);
  for (let i = 0; i < random.length; i++) random[i] = (i * 7919 + 13) % 251;
  assert.throws(() => openZip(random), /Not a ZIP archive/);
  assert.throws(() => openZip(Buffer.alloc(0)), /Not a ZIP archive/);
  assert.throws(() => openZip(Buffer.from('PK')), ZipError);

  const zip = makeZip([
    { name: 'a.xml', data: '<a>' + 'text '.repeat(200) + '</a>' },
    { name: 'b.xml', data: '<b/>' },
  ]);
  // Truncated download: the end record is gone.
  assert.throws(() => openZip(zip.subarray(0, Math.floor(zip.length / 2))), /Not a ZIP archive/);
  // The end record survives but the directory offset points past it.
  const badOffset = Buffer.from(zip);
  badOffset.writeUInt32LE(zip.length, endRecord(zip) + 16);
  assert.throws(() => openZip(badOffset), /central directory lies outside the file/);
  // A damaged central directory entry.
  const badDirectory = Buffer.from(zip);
  badDirectory.writeUInt32LE(0xdeadbeef, badDirectory.readUInt32LE(endRecord(zip) + 16));
  assert.throws(() => openZip(badDirectory), /central directory entry is damaged/);
  // Damaged compressed data is reported on read.
  const badData = Buffer.from(zip);
  badData.fill(0xff, 40, 60);
  assert.throws(() => openZip(badData).read('a.xml'), /Corrupt ZIP archive: ZIP entry "a.xml"/);
  // A local header offset that points at garbage.
  const badLocal = Buffer.from(zip);
  badLocal.writeUInt32LE(0x11111111, 0);
  assert.throws(() => openZip(badLocal).read('a.xml'), /has no local header/);
  // Wrong checksum.
  assert.throws(() => openZip(makeZip([{ name: 'c', data: 'data', declaredCrc: 12345 }])).read('c'), /size or checksum/);
});

test('refuses unsupported methods, encryption, ZIP64, split archives, ".." and duplicate names', () => {
  const zip = openZip(
    makeZip([
      { name: 'lzma.bin', data: 'x', method: 14 },
      { name: 'secret.xml', data: '<s/>', flags: 0x1 },
      { name: 'fine.xml', data: '<ok/>' },
    ]),
  );
  // Opening works; only the unreadable entries fail, with a clear reason.
  assert.throws(() => zip.read('lzma.bin'), /uses compression method 14; only stored \(0\) and deflate \(8\) are supported/);
  assert.throws(() => zip.read('secret.xml'), /ZIP entry "secret.xml" is encrypted/);
  assert.equal(zip.readText('fine.xml'), '<ok/>');

  const plain = makeZip([{ name: 'a', data: 'a' }]);
  const zip64 = Buffer.from(plain);
  zip64.writeUInt16LE(0xffff, endRecord(plain) + 8);
  zip64.writeUInt16LE(0xffff, endRecord(plain) + 10);
  assert.throws(() => openZip(zip64), /ZIP64 archives are not supported/);
  const zip64Offset = Buffer.from(plain);
  zip64Offset.writeUInt32LE(0xffffffff, endRecord(plain) + 16);
  assert.throws(() => openZip(zip64Offset), /ZIP64/);
  const zip64Entry = openZip(makeZip([{ name: 'huge', data: 'a', declaredSize: 0xffffffff }]), { maxEntryBytes: 0xffffffff });
  assert.throws(() => zip64Entry.read('huge'), /needs ZIP64/);

  const split = Buffer.from(plain);
  split.writeUInt16LE(1, endRecord(plain) + 4);
  assert.throws(() => openZip(split), /Split \(multi-part\) ZIP archives are not supported/);

  assert.throws(() => openZip(makeZip([{ name: 'word/../../evil.xml', data: '' }])), /contains "\.\."/);
  assert.throws(() => openZip(makeZip([{ name: '..\\evil.xml', data: '' }])), /contains "\.\."/);
  assert.doesNotThrow(() => openZip(makeZip([{ name: 'word/..hidden..', data: '' }])), 'dots inside a segment are fine');
  assert.throws(
    () =>
      openZip(
        makeZip([
          { name: 'a.xml', data: '1' },
          { name: 'a.xml', data: '2' },
        ]),
      ),
    /lists "a.xml" twice/,
  );
});
