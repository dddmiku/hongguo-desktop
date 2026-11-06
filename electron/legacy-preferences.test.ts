import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLegacyPreferences } from './legacy-preferences';
import { readLegacy } from './migration';

const workspace = path.resolve('_work/legacy-preferences-tests');
let root: string, directory: string;
beforeEach(async () => { await fs.mkdir(workspace, { recursive: true }); root = await fs.mkdtemp(path.join(workspace, 'case-')); directory = path.join(root, 'EBWebView', 'Default', 'Local Storage', 'leveldb'); await fs.mkdir(directory, { recursive: true }); });
afterEach(async () => { if (root.startsWith(workspace + path.sep)) await fs.rm(root, { recursive: true, force: true }); });
const vint = (value: bigint | number) => { let rest = BigInt(value); const bytes: number[] = []; do { bytes.push(Number(rest & 127n) | (rest > 127n ? 128 : 0)); rest >>= 7n; } while (rest); return Buffer.from(bytes); };
const field = (value: Buffer) => Buffer.concat([vint(value.length), value]);
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
function crc(data: Buffer) { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1; } value = (value ^ 0xffffffff) >>> 0; return (((value >>> 15) | (value << 17)) + 0xa282ead8) >>> 0; }
function logical(record: Buffer) {
  const result: Buffer[] = []; let offset = 0, written = 0;
  while (written < record.length) {
    const remaining = 32768 - offset % 32768;
    if (remaining < 7) { result.push(Buffer.alloc(remaining)); offset += remaining; continue; }
    const size = Math.min(remaining - 7, record.length - written), final = written + size === record.length;
    const type = written === 0 ? final ? 1 : 2 : final ? 4 : 3;
    const data = record.subarray(written, written + size), header = Buffer.alloc(7); header.writeUInt32LE(crc(Buffer.concat([Buffer.from([type]), data]))); header.writeUInt16LE(size, 4); header[6] = type;
    result.push(header, data); written += size; offset += size + 7;
  }
  return Buffer.concat(result);
}
function key(name: string, origin = 'https://tauri.localhost', utf16 = false) { return Buffer.concat([Buffer.from('_' + origin + '\0'), Buffer.from([utf16 ? 0 : 1]), Buffer.from(name, utf16 ? 'utf16le' : 'latin1')]); }
function value(text: string, utf16 = false) { return Buffer.concat([Buffer.from([utf16 ? 0 : 1]), Buffer.from(text, utf16 ? 'utf16le' : 'latin1')]); }
function writeBatch(sequence: number, rows: Array<{ key: Buffer; value?: Buffer }>) {
  const header = Buffer.alloc(12); header.writeBigUInt64LE(BigInt(sequence)); header.writeUInt32LE(rows.length, 8);
  return logical(Buffer.concat([header, ...rows.map(row => Buffer.concat([Buffer.from([row.value ? 1 : 0]), field(row.key), ...(row.value ? [field(row.value)] : [])]))]));
}
async function manifest(tables: number[] = [], log = 10, removed: number[] = []) {
  const record = Buffer.concat([vint(2), vint(log), ...tables.map(number => Buffer.concat([vint(7), vint(0), vint(number), vint(100), field(Buffer.alloc(0)), field(Buffer.alloc(0))])), ...removed.map(number => Buffer.concat([vint(6), vint(0), vint(number)]))]);
  await fs.writeFile(path.join(directory, 'CURRENT'), 'MANIFEST-000001\n'); await fs.writeFile(path.join(directory, 'MANIFEST-000001'), logical(record));
}
function rawBlock(rows: Array<{ key: Buffer; value: Buffer }>) {
  let previous: Buffer = Buffer.alloc(0);
  const bytes = rows.map(row => { let shared = 0; while (shared < Math.min(row.key.length, previous.length) && row.key[shared] === previous[shared]) shared++; const next = Buffer.concat([vint(shared), vint(row.key.length - shared), vint(row.value.length), row.key.subarray(shared), row.value]); previous = row.key; return next; });
  return Buffer.concat([...bytes, u32(0), u32(1)]);
}
function literal(input: Buffer) { const length = input.length - 1; if (length < 60) return Buffer.concat([Buffer.from([length << 2]), input]); const bytes = length <= 255 ? 1 : 2, header = Buffer.alloc(bytes); header.writeUIntLE(length, 0, bytes); return Buffer.concat([Buffer.from([(59 + bytes) << 2]), header, input]); }
function frame(data: Buffer, compression: number) { return Buffer.concat([data, Buffer.from([compression]), u32(crc(Buffer.concat([data, Buffer.from([compression])])))]); }
function sstable(rows: Array<{ key: Buffer; value: Buffer; sequence: number }>, copyType = 0) {
  const data = rawBlock(rows.map(row => { const tag = Buffer.alloc(8); tag.writeBigUInt64LE(BigInt(row.sequence) << 8n | 1n); return { key: Buffer.concat([row.key, tag]), value: row.value }; }));
  const encoded = copyType ? Buffer.concat([vint(data.length), literal(data)]) : data, dataFrame = frame(encoded, copyType ? 1 : 0);
  const handle = Buffer.concat([vint(0), vint(encoded.length)]), index = rawBlock([{ key: Buffer.from('aaaaaaaaa'), value: handle }]);
  let indexBytes = index;
  if (copyType) {
    const copy = copyType === 1 ? Buffer.from([9, 3]) : copyType === 2 ? Buffer.from([22, 3, 0]) : Buffer.from([23, 3, 0, 0, 0]);
    // Index header is three one-byte varints, followed by nine repeated bytes.
    indexBytes = Buffer.concat([vint(index.length), literal(index.subarray(0, 6)), copy, literal(index.subarray(12))]);
  }
  const indexFrame = frame(indexBytes, copyType ? 1 : 0), footer = Buffer.alloc(48);
  Buffer.concat([vint(0), vint(0), vint(dataFrame.length), vint(indexBytes.length)]).copy(footer); footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([dataFrame, indexFrame, footer]);
}

describe('explicit read-only Chromium preference migration', () => {
  it('reads the confirmed preference keys from a checksummed WriteBatch and ignores other storage', async () => {
    await manifest(); await fs.writeFile(path.join(directory, '000010.log'), writeBatch(100, [{ key: key('guoban:preferences'), value: value(JSON.stringify({ playbackRate: 3, autoNext: false })) }, { key: key('guoban:quality'), value: value('1080p') }, { key: key('guoban:api'), value: value('fixture-private-value') }]));
    expect(await readLegacyPreferences(root)).toEqual({ quality: '1080p', rate: 3, autoplay: false });
  });
  for (const compression of [0, 1, 2, 3]) it(`reads SSTable prefix compression with Snappy copy type ${compression}`, async () => {
    await manifest([5]); await fs.writeFile(path.join(directory, '000005.ldb'), sstable([{ key: key('guoban:preferences', undefined, true), value: value(JSON.stringify({ playbackRate: 2.5, autoNext: true }), true), sequence: 91 }, { key: key('guoban:quality', undefined, true), value: value('720p', true), sequence: 92 }], compression));
    expect(await readLegacyPreferences(root)).toEqual({ quality: '720p', rate: 2.5, autoplay: true });
  });
  it('uses newer WAL writes and preserves deleted preference tombstones', async () => {
    await manifest([5]); await fs.writeFile(path.join(directory, '000005.ldb'), sstable([{ key: key('guoban:quality'), value: value('720p'), sequence: 10 }]));
    await fs.writeFile(path.join(directory, '000010.log'), writeBatch(20, [{ key: key('guoban:quality') }, { key: key('guoban:preferences'), value: value('{"playbackRate":1.5}') }]));
    expect(await readLegacyPreferences(root)).toEqual({ rate: 1.5 });
  });
  it('does not import obsolete SSTables removed from the current manifest', async () => {
    await manifest([5], 10, [5]); await fs.writeFile(path.join(directory, '000005.ldb'), sstable([{ key: key('guoban:quality'), value: value('1080p'), sequence: 200 }]));
    expect(await readLegacyPreferences(root)).toEqual({});
  });
  it('reassembles fragmented WAL records and filters unrelated origins', async () => {
    await manifest(); await fs.writeFile(path.join(directory, '000010.log'), writeBatch(200, [{ key: key('unrelated-key'), value: value('x'.repeat(70000)) }, { key: key('guoban:quality', 'https://unrelated.invalid'), value: value('480p') }, { key: key('guoban:quality'), value: value('1080p') }]));
    expect(await readLegacyPreferences(root)).toEqual({ quality: '1080p' });
  });
  it('ignores corrupt/incomplete records and unreadable manifests without guessing preferences', async () => {
    await manifest(); const wal = writeBatch(10, [{ key: key('guoban:quality'), value: value('1080p') }]); wal[0] ^= 1; await fs.writeFile(path.join(directory, '000010.log'), wal);
    expect(await readLegacyPreferences(root)).toEqual({});
    await fs.writeFile(path.join(directory, '000010.log'), writeBatch(10, [{ key: key('guoban:quality'), value: value('1080p') }]).subarray(0, 20));
    expect(await readLegacyPreferences(root)).toEqual({});
    await fs.writeFile(path.join(directory, 'CURRENT'), 'unsupported-manifest');
    expect(await readLegacyPreferences(root)).toEqual({});
  });
  it('reads WebView preferences only when migration receives the explicit second path', async () => {
    await manifest(); await fs.writeFile(path.join(directory, '000010.log'), writeBatch(100, [{ key: key('guoban:preferences'), value: value('{"playbackRate":3}') }]));
    expect((await readLegacy(path.join(root, 'empty-data'))).settings).toBeUndefined();
    expect((await readLegacy(path.join(root, 'empty-data'), root)).settings).toEqual({ rate: 3 });
  });
});
