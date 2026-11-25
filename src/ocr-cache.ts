/**
 * Text read from scans by Google's OCR, kept encrypted so that reading on (the next slice of a long
 * contract, the same attachment in another chat) costs no new OCR. A Drive file is keyed by its id and
 * version, so an edited file is read again; an attachment by its bytes. Kept 90 days.
 */
import type { Db } from './db.js';
import { decryptBytes, deriveKey, encryptBytes } from './crypto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class OcrCache {
  private readonly keys: Buffer[];

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => k !== undefined).map((k) => deriveKey(k, 'ocr text v1'));
    if (!this.keys.length) throw new Error('OcrCache needs an encryption key');
    db.exec(`CREATE TABLE IF NOT EXISTS ocr_text (
      source TEXT PRIMARY KEY,
      text_enc BLOB NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  get(source: string): string | undefined {
    const row = this.db.prepare('SELECT text_enc FROM ocr_text WHERE source = ?').get(source) as { text_enc: Uint8Array } | undefined;
    if (!row) return undefined;
    try {
      return decryptBytes(row.text_enc, this.keys, source).toString('utf8');
    } catch {
      return undefined;
    }
  }

  put(source: string, text: string): void {
    const blob = encryptBytes(Buffer.from(text, 'utf8'), this.keys[0]!, source);
    this.db.prepare('INSERT INTO ocr_text (source, text_enc, created_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET text_enc = excluded.text_enc, created_at = excluded.created_at').run(source, blob, this.now());
    this.db.prepare('DELETE FROM ocr_text WHERE created_at < ?').run(this.now() - 90 * DAY_MS);
  }
}
