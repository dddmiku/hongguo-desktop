import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readUpdateInfo, UpdateInstaller } from './updater';
import { REPOSITORY } from '../shared/meta';

const version = '2.0.0';
const url = REPOSITORY + '/releases/download/v' + version + '/hongguo-' + version + '-setup.exe';
const feedUrl = REPOSITORY + '/releases/latest/download/latest.json';
const installer = Buffer.from('fixture installer body');
const sha256 = createHash('sha256').update(installer).digest('hex');
const info = { version, url, sha256, available: true, notes: '新版本' };

function feed() {
  const response = Response.json({ notes: info.notes, platforms: { 'windows-x86_64': info } });
  Object.defineProperty(response, 'url', { value: 'https://release-assets.githubusercontent.com/feed' });
  return response;
}

async function inWorkspace(run: (directory: string) => Promise<void>) {
  const root = path.resolve('_work');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'updater-test-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

describe('Windows app updates', () => {
  it('reads the current Windows package from the repository feed', async () => {
    const request = vi.fn(async () => feed());
    expect(await readUpdateInfo('1.4.8', request)).toEqual(info);
    expect(request).toHaveBeenCalledExactlyOnceWith(feedUrl, { signal: expect.any(AbortSignal) });
    expect(await readUpdateInfo(version, request)).toEqual({ ...info, available: false });
  });

  it('holds the download lock while checking and awaiting the install decision', () => inWorkspace(async directory => {
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValueOnce(feed()).mockResolvedValueOnce(new Response(installer, { headers: { 'content-length': String(installer.length) } }));
    let finish!: () => void;
    const confirm = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const update = new UpdateInstaller(directory, '1.4.8', vi.fn(), confirm, request);
    const download = update.download(info);
    await expect(update.download(info)).rejects.toThrow('正在下载');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await expect(update.download(info)).rejects.toThrow('正在下载');
    finish();
    await download;
    expect(await fs.readFile(path.join(directory, 'hongguo-update.exe'))).toEqual(installer);
    expect(existsSync(path.join(directory, 'hongguo-update.exe.part'))).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  }));

  it('can retry after the update directory could not be created', () => inWorkspace(async directory => {
    const target = path.join(directory, 'updates');
    const moved = path.join(directory, 'old-file');
    await fs.writeFile(target, 'occupied');
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValueOnce(feed()).mockResolvedValueOnce(feed()).mockResolvedValueOnce(new Response(installer));
    const confirm = vi.fn(async () => {});
    const update = new UpdateInstaller(target, '1.4.8', vi.fn(), confirm, request);
    await expect(update.download(info)).rejects.toThrow('无法写入更新目录');
    await fs.rename(target, moved);
    await update.download(info);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(target, 'hongguo-update.exe'))).toEqual(installer);
  }));

  it('uses the next route after a mirror fails and writes the complete stream', () => inWorkspace(async directory => {
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(installer.subarray(0, 7));
      controller.enqueue(installer.subarray(7));
      controller.close();
    } }));
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValueOnce(feed()).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(response);
    const confirm = vi.fn(async () => {});
    const report = vi.fn();
    await new UpdateInstaller(directory, '1.4.8', report, confirm, request).download(info);
    expect(request).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledWith({ phase: 'downloading', downloaded: 7, total: 0 });
    expect(report).toHaveBeenCalledWith({ phase: 'downloading', downloaded: installer.length, total: 0 });
    expect(await fs.readFile(path.join(directory, 'hongguo-update.exe'))).toEqual(installer);
    expect(confirm).toHaveBeenCalledTimes(1);
  }));
});
