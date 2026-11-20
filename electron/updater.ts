import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { UpdateInfo, UpdateTask } from '../shared/contracts';
import { REPOSITORY } from '../shared/meta';

const versionPattern = /^\d+(?:\.\d+){1,3}$/;
const maxInstallerBytes = 300 * 1024 * 1024;
const assetRoutes = ['https://v4.gh-proxy.org/', 'https://gh-proxy.org/', ''];
const feedUrl = REPOSITORY + '/releases/latest/download/latest.json';
const trustedFeedOrigins = new Set(['https://github.com', 'https://release-assets.githubusercontent.com']);

function installerUrl(version: string) {
  return REPOSITORY + '/releases/download/v' + version + '/hongguo-' + version + '-setup.exe';
}

function validAsset(info: UpdateInfo) {
  return typeof info?.version === 'string' && versionPattern.test(info.version) &&
    info.url === installerUrl(info.version) && typeof info.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(info.sha256);
}

function newerVersion(version: string, current: string) {
  const next = version.split('.').map(Number), previous = current.split('.').map(Number);
  for (let i = 0; i < Math.max(next.length, previous.length); i++) {
    const difference = (next[i] ?? 0) - (previous[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

export async function readUpdateInfo(current: string, request: typeof fetch = fetch): Promise<UpdateInfo> {
  try {
    // A download mirror must never decide the expected hash of an executable it serves.
    const response = await request(feedUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok || !trustedFeedOrigins.has(new URL(response.url).origin)) {
      await response.body?.cancel();
      throw new Error('Invalid update feed origin');
    }
    const feed = await response.json();
    const platform = feed.platforms?.['windows-x86_64'];
    const info: UpdateInfo = {
      available: false,
      version: platform?.version ?? feed.version,
      notes: typeof feed.notes === 'string' ? feed.notes : '',
      url: platform?.url ?? '',
      sha256: platform?.sha256 ?? feed.sha256 ?? '',
    };
    if (!validAsset(info)) throw new Error('Invalid update feed');
    return { ...info, available: newerVersion(info.version, current), sha256: info.sha256.toLowerCase() };
  } catch {
    throw new Error('暂时无法读取 GitHub 更新，请稍后重试');
  }
}

export class UpdateInstaller {
  private downloading = false;

  constructor(
    private directory: string,
    private currentVersion: string,
    private report: (task: UpdateTask) => void,
    private confirmInstall: (file: string) => Promise<void>,
    private request: typeof fetch = fetch,
  ) {}

  async download(info: UpdateInfo) {
    if (this.downloading) throw new Error('正在下载，请稍候');
    if (!validAsset(info)) throw new Error('更新信息不完整，请重新检查更新');
    this.downloading = true;
    const dest = path.join(this.directory, 'hongguo-update.exe');
    const part = dest + '.part';
    let needsCleanup = false;
    try {
      const latest = await readUpdateInfo(this.currentVersion, this.request);
      if (!latest.available || latest.url !== info.url || latest.sha256 !== info.sha256.toLowerCase()) {
        throw new Error('更新版本已变化，请重新检查更新');
      }
      try { await fs.mkdir(this.directory, { recursive: true }); }
      catch { throw new Error('无法写入更新目录，请检查磁盘空间后重试'); }
      needsCleanup = true;
      let success = false;
      for (const prefix of assetRoutes) {
        try {
          await this.downloadAsset(prefix + latest.url, latest.sha256, part);
          await fs.rename(part, dest);
          success = true;
          break;
        } catch {
          await fs.rm(part, { force: true });
        }
      }
      if (!success) throw new Error('下载失败，请稍后重试');
      this.report({ phase: 'done', downloaded: 1, total: 1 });
      await this.confirmInstall(dest);
    } catch (error) {
      this.report({ phase: 'error', downloaded: 0, total: 0, error: error instanceof Error ? error.message : '更新失败，请稍后重试' });
      throw error;
    } finally {
      if (needsCleanup) await fs.rm(part, { force: true }).catch(() => {});
      this.downloading = false;
    }
  }

  private async downloadAsset(url: string, digest: string, part: string) {
    const response = await this.request(url, { signal: AbortSignal.timeout(240000) });
    const total = Number(response.headers.get('content-length')) || 0;
    if (!response.ok || !response.body || total > maxInstallerBytes) {
      await response.body?.cancel();
      throw new Error('安装包暂时无法下载');
    }
    let downloaded = 0;
    const hash = createHash('sha256');
    const file = await fs.open(part, 'w').catch(async error => {
      await response.body?.cancel().catch(() => {});
      throw error;
    });
    try {
      for await (const chunk of response.body) {
        downloaded += chunk.length;
        if (downloaded > maxInstallerBytes) throw new Error('安装包大小异常');
        await file.writeFile(chunk);
        hash.update(chunk);
        this.report({ phase: 'downloading', downloaded, total });
      }
    } finally {
      await file.close();
    }
    if (hash.digest('hex') !== digest || (total && downloaded !== total)) throw new Error('安装包校验失败');
  }
}
