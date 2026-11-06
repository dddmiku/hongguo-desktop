import fs from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '../shared/contracts';
import { validateSettings } from './store';

const BLOCK_SIZE = 32768, MAX_FILE = 16 * 1024 * 1024, MAX_BLOCK = 32 * 1024 * 1024;
const ALLOWED_KEYS = new Set(['guoban:preferences', 'guoban:quality']);
const ALLOWED_ORIGINS = new Set(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']);
const TABLE_MAGIC = 0xdb4775248b80fb57n;
type Candidate = { sequence: bigint; value?: Buffer };

function varint(data: Buffer, cursor: { value: number }): bigint {
  let value = 0n;
  for (let shift = 0n; shift < 64n; shift += 7n) {
    if (cursor.value >= data.length) throw new Error('Truncated varint');
    const byte = data[cursor.value++]; value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return value;
  }
  throw new Error('Invalid varint');
}
function slice(data: Buffer, cursor: { value: number }): Buffer {
  const size = Number(varint(data, cursor)), end = cursor.value + size;
  if (!Number.isSafeInteger(size) || end > data.length) throw new Error('Truncated field');
  const value = data.subarray(cursor.value, end); cursor.value = end; return value;
}

const crcTable = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1; return crc >>> 0; });
function maskedCRC(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

/** Raw Snappy block decoding. This does not load or modify the Chromium database. */
function snappy(input: Buffer): Buffer {
  const cursor = { value: 0 }, length = Number(varint(input, cursor));
  if (length > MAX_BLOCK || !Number.isSafeInteger(length)) throw new Error('Snappy block too large');
  const output = Buffer.alloc(length); let written = 0;
  while (cursor.value < input.length && written < length) {
    const tag = input[cursor.value++], type = tag & 3;
    let count: number, offset = 0;
    if (type === 0) {
      count = tag >>> 2;
      if (count < 60) count++;
      else { const bytes = count - 59; if (cursor.value + bytes > input.length || bytes > 4) throw new Error('Invalid Snappy literal'); count = input.readUIntLE(cursor.value, bytes) + 1; cursor.value += bytes; }
      if (cursor.value + count > input.length || written + count > length) throw new Error('Invalid Snappy bounds');
      input.copy(output, written, cursor.value, cursor.value + count); cursor.value += count; written += count;
    } else {
      if (type === 1) { count = 4 + ((tag >>> 2) & 7); if (cursor.value >= input.length) throw new Error('Truncated Snappy copy'); offset = ((tag & 224) << 3) | input[cursor.value++]; }
      else { count = 1 + (tag >>> 2); const bytes = type === 2 ? 2 : 4; if (cursor.value + bytes > input.length) throw new Error('Truncated Snappy copy'); offset = input.readUIntLE(cursor.value, bytes); cursor.value += bytes; }
      if (!offset || offset > written || written + count > length) throw new Error('Invalid Snappy copy');
      for (let i = 0; i < count; i++) output[written + i] = output[written + i - offset];
      written += count;
    }
  }
  if (written !== length || cursor.value !== input.length) throw new Error('Incomplete Snappy block');
  return output;
}

function* records(data: Buffer): Generator<Buffer> {
  let offset = 0, fragments: Buffer[] | undefined;
  while (offset + 7 <= data.length) {
    const remaining = BLOCK_SIZE - offset % BLOCK_SIZE;
    if (remaining < 7) { offset += remaining; continue; }
    const size = data.readUInt16LE(offset + 4), type = data[offset + 6];
    if (!size && !type) { offset += remaining; fragments = undefined; continue; }
    if (size > remaining - 7 || offset + 7 + size > data.length) break;
    const value = data.subarray(offset + 7, offset + 7 + size), stored = data.readUInt32LE(offset);
    offset += size + 7;
    if (stored !== maskedCRC(Buffer.concat([Buffer.from([type]), value]))) { fragments = undefined; continue; }
    if (type === 1) { fragments = undefined; yield value; }
    else if (type === 2) fragments = [value];
    else if (type === 3 && fragments) fragments.push(value);
    else if (type === 4 && fragments) { fragments.push(value); yield Buffer.concat(fragments); fragments = undefined; }
    else fragments = undefined;
  }
}

function preferenceKey(key: Buffer): string | undefined {
  if (key[0] !== 95) return undefined;
  const separator = key.indexOf(0, 1); if (separator < 2) return undefined;
  if (!ALLOWED_ORIGINS.has(key.subarray(1, separator).toString('utf8'))) return undefined;
  const encoded = key.subarray(separator + 1);
  const name = encoded[0] === 1 ? encoded.subarray(1).toString('latin1') : encoded[0] === 0 ? encoded.subarray(1).toString('utf16le') : '';
  return ALLOWED_KEYS.has(name) ? name : undefined;
}
function retain(values: Map<string, Candidate>, key: Buffer, value: Buffer | undefined, sequence: bigint): void {
  const name = preferenceKey(key); if (!name) return;
  const current = values.get(name);
  if (!current || sequence > current.sequence) values.set(name, { sequence, value: value && Buffer.from(value) });
}
function batch(data: Buffer, values: Map<string, Candidate>): void {
  if (data.length < 12) return;
  const sequence = data.readBigUInt64LE(0), count = data.readUInt32LE(8), cursor = { value: 12 };
  if (count > 100000) return;
  const pending: Array<{ key: Buffer; value?: Buffer; sequence: bigint }> = [];
  for (let i = 0; i < count; i++) {
    const type = data[cursor.value++]; if (type !== 0 && type !== 1) throw new Error('Unknown write operation');
    const key = slice(data, cursor), value = type === 1 ? slice(data, cursor) : undefined;
    pending.push({ key, value, sequence: sequence + BigInt(i) });
  }
  if (cursor.value !== data.length) throw new Error('Incomplete write batch');
  for (const entry of pending) retain(values, entry.key, entry.value, entry.sequence);
}

function block(file: Buffer, offset: number, size: number): Buffer {
  if (offset < 0 || size < 0 || offset + size + 5 > file.length) throw new Error('Invalid table block');
  const raw = file.subarray(offset, offset + size), compression = file[offset + size];
  if (file.readUInt32LE(offset + size + 1) !== maskedCRC(Buffer.concat([raw, Buffer.from([compression])]))) throw new Error('Invalid table checksum');
  return compression === 0 ? raw : compression === 1 ? snappy(raw) : (() => { throw new Error('Unsupported table compression'); })();
}
function* entries(data: Buffer): Generator<{ key: Buffer; value: Buffer }> {
  if (data.length < 4) throw new Error('Incomplete table entries');
  const count = data.readUInt32LE(data.length - 4), end = data.length - 4 - count * 4;
  if (!count || end < 0) throw new Error('Invalid table restarts');
  const cursor = { value: 0 }; let previous = Buffer.alloc(0);
  while (cursor.value < end) {
    const shared = Number(varint(data, cursor)), suffix = Number(varint(data, cursor)), size = Number(varint(data, cursor));
    if (shared > previous.length || cursor.value + suffix + size > end) throw new Error('Invalid table entry');
    const key = Buffer.concat([previous.subarray(0, shared), data.subarray(cursor.value, cursor.value + suffix)]); cursor.value += suffix;
    const value = data.subarray(cursor.value, cursor.value + size); cursor.value += size; previous = key;
    yield { key, value };
  }
}
function table(file: Buffer, values: Map<string, Candidate>): void {
  if (file.length < 48 || file.readBigUInt64LE(file.length - 8) !== TABLE_MAGIC) return;
  const footer = file.subarray(file.length - 48, file.length - 8), cursor = { value: 0 };
  varint(footer, cursor); varint(footer, cursor); // Metaindex handle.
  const indexOffset = Number(varint(footer, cursor)), indexSize = Number(varint(footer, cursor));
  for (const entry of entries(block(file, indexOffset, indexSize))) {
    const handle = { value: 0 }, offset = Number(varint(entry.value, handle)), size = Number(varint(entry.value, handle));
    for (const row of entries(block(file, offset, size))) {
      if (row.key.length < 8) continue;
      const tag = row.key.readBigUInt64LE(row.key.length - 8), type = Number(tag & 255n);
      if (type === 0 || type === 1) retain(values, row.key.subarray(0, -8), type === 1 ? row.value : undefined, tag >> 8n);
    }
  }
}

async function manifestFiles(directory: string): Promise<{ tables: Set<string>; log: bigint; previousLog: bigint } | undefined> {
  try {
    const current = (await fs.readFile(path.join(directory, 'CURRENT'), 'utf8')).trim(); if (!/^MANIFEST-\d+$/.test(current)) return undefined;
    const data = await fs.readFile(path.join(directory, current)); if (data.length > MAX_FILE) return undefined;
    const tables = new Set<string>(); let log = 0n, previousLog = 0n;
    for (const record of records(data)) {
      const cursor = { value: 0 };
      while (cursor.value < record.length) {
        const tag = Number(varint(record, cursor));
        if (tag === 1) slice(record, cursor);
        else if (tag === 2) log = varint(record, cursor);
        else if (tag === 9) previousLog = varint(record, cursor);
        else if (tag === 3 || tag === 4) varint(record, cursor);
        else if (tag === 5) { varint(record, cursor); slice(record, cursor); }
        else if (tag === 6) { varint(record, cursor); tables.delete(String(varint(record, cursor))); }
        else if (tag === 7) { varint(record, cursor); tables.add(String(varint(record, cursor))); varint(record, cursor); slice(record, cursor); slice(record, cursor); }
        else throw new Error('Unknown manifest edit');
      }
    }
    return { tables, log, previousLog };
  } catch { return undefined; }
}

function decode(value?: Buffer): string | undefined {
  if (!value || value.length > 65536) return undefined;
  return value[0] === 1 ? value.subarray(1).toString('latin1') : value[0] === 0 ? value.subarray(1).toString('utf16le') : undefined;
}

/** Explicit profile opt-in only; reads the two confirmed preference keys and never returns other storage. */
export async function readLegacyPreferences(webviewRoot: string): Promise<Partial<Settings>> {
  const root = path.resolve(webviewRoot);
  const paths = [path.join(root, 'EBWebView', 'Default', 'Local Storage', 'leveldb'), path.join(root, 'Default', 'Local Storage', 'leveldb'), path.join(root, 'Local Storage', 'leveldb'), ...(path.basename(root) === 'leveldb' ? [root] : [])];
  let directory = '';
  for (const candidate of paths) { try { if ((await fs.stat(candidate)).isDirectory()) { directory = candidate; break; } } catch { /* Other supported profile roots may exist. */ } }
  if (!directory) return {};
  const values = new Map<string, Candidate>(), active = await manifestFiles(directory);
  // An unreadable manifest cannot establish which obsolete tables have been removed.
  if (!active) return {};
  const files = (await fs.readdir(directory)).filter(name => /^\d+\.(ldb|sst|log)$/.test(name));
  for (const name of files) {
    const number = BigInt(name.split('.')[0]), wal = name.endsWith('.log');
    if (active && (wal ? number < active.log && number !== active.previousLog : !active.tables.has(String(number)))) continue;
    try {
      const file = path.join(directory, name); if ((await fs.stat(file)).size > MAX_FILE) continue;
      const data = await fs.readFile(file);
      if (wal) for (const record of records(data)) { try { batch(record, values); } catch { /* An incomplete active WAL record is ignored. */ } }
      else table(data, values);
    } catch { /* Corrupt/rotating files must not replace new defaults with guessed settings. */ }
  }
  const result: Partial<Settings> = {}, preferences = decode(values.get('guoban:preferences')?.value), quality = decode(values.get('guoban:quality')?.value);
  if (preferences) { try { const value = JSON.parse(preferences); Object.assign(result, validateSettings({ rate: value.playbackRate, autoplay: value.autoNext })); } catch { /* Invalid preference JSON stays at new defaults. */ } }
  if (quality) Object.assign(result, validateSettings({ quality }));
  return result;
}
