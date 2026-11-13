// 模组下载：Modrinth 元数据（官方 API）+ 文件（1B1T 镜像优先 → 官方 CDN 兜底）
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveGameDir } from './config';
import { runDownloads, sha1File, type ResourceFile } from './downloader';
import { httpDownload } from './http';
import type { InstalledMod, ModFile, ModHit, ModUpdate, ModVersionInfo } from './types';

/** 元数据 API：官方优先，镜像兜底 */
const API_OFFICIAL = 'https://api.modrinth.com';
const API_MIRROR = 'https://mcdown.cn-nb1.rains3.com/modrinth';
/** 文件 CDN：镜像优先（有同步的才命中），官方兜底 */
const CDN_OFFICIAL = 'https://cdn.modrinth.com';
const CDN_MIRROR = 'https://mcdown.cn-nb1.rains3.com/modrinth';

interface RawHit {
  project_id?: string;
  slug?: string;
  title?: string;
  description?: string;
  author?: string;
  downloads?: number;
  follows?: number;
  icon_url?: string;
  categories?: string[];
}

interface RawVersion {
  id?: string;
  name?: string;
  version_number?: string;
  game_versions?: string[];
  loaders?: string[];
  date_published?: string;
  files?: { url?: string; filename?: string; size?: number; primary?: boolean; hashes?: { sha1?: string } }[];
  dependencies?: { project_id?: string; version_id?: string; dependency_type?: string }[];
}

function tmpJsonPath(): string {
  return path.join(os.tmpdir(), `mcore-mod-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

/** GET JSON：多个候选依次尝试（超时/404 自动换源） */
async function fetchJson(urls: string[], timeoutMs = 15000): Promise<unknown> {
  const tmp = tmpJsonPath();
  let lastErr = '无可用接口';
  try {
    for (const url of urls) {
      try {
        const r = await httpDownload(url, tmp, { timeoutMs });
        if (r.ok) return JSON.parse(fs.readFileSync(tmp, 'utf-8')) as unknown;
        lastErr = `${url}: ${r.error || `HTTP ${r.status}`}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(lastErr);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

function toHit(h: RawHit): ModHit {
  return {
    id: h.project_id ?? '',
    slug: h.slug ?? '',
    title: h.title ?? h.slug ?? '',
    description: h.description ?? '',
    author: h.author ?? '',
    downloads: h.downloads ?? 0,
    follows: h.follows ?? 0,
    iconUrl: h.icon_url ?? '',
    categories: h.categories ?? [],
  };
}

function toVersion(v: RawVersion): ModVersionInfo | null {
  const file = v.files?.find((f) => f.primary) ?? v.files?.[0];
  if (!file?.url || !file.filename) return null;
  return {
    id: v.id ?? '',
    name: v.name ?? v.version_number ?? '',
    versionNumber: v.version_number ?? '',
    gameVersions: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    datePublished: v.date_published ?? '',
    file: {
      url: file.url,
      filename: file.filename,
      size: file.size ?? 0,
      sha1: file.hashes?.sha1 ?? '',
    },
    dependencies: (v.dependencies ?? [])
      .filter((d) => d.dependency_type === 'required' && (d.project_id || d.version_id))
      .map((d) => ({ projectId: d.project_id ?? '', versionId: d.version_id ?? '', type: d.dependency_type ?? '' })),
  };
}

/** 搜索模组（按 MC 版本 + 加载器过滤） */
export async function searchMods(opts: {
  query: string;
  mcVersion: string;
  loader: string;
  offset?: number;
  limit?: number;
  sort?: string;
}): Promise<{ hits: ModHit[]; total: number }> {
  const facets: string[][] = [['project_type:mod']];
  if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`]);
  if (opts.loader) facets.push([`categories:${opts.loader}`]);
  const params = new URLSearchParams({
    query: opts.query ?? '',
    limit: String(opts.limit ?? 20),
    offset: String(opts.offset ?? 0),
    index: opts.sort || (opts.query ? 'relevance' : 'downloads'),
    facets: JSON.stringify(facets),
  });
  const qs = params.toString();
  const data = (await fetchJson([`${API_OFFICIAL}/v2/search?${qs}`, `${API_MIRROR}/v2/search?${qs}`])) as {
    hits?: RawHit[];
    total_hits?: number;
  };
  return { hits: (data.hits ?? []).map(toHit), total: data.total_hits ?? 0 };
}

/** 某模组适配当前 MC 版本 / 加载器的全部版本（新→旧） */
export async function listModVersions(idOrSlug: string, mcVersion: string, loader: string): Promise<ModVersionInfo[]> {
  const params = new URLSearchParams();
  if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
  if (loader) params.set('loaders', JSON.stringify([loader]));
  const qs = params.toString();
  const base = `/v2/project/${encodeURIComponent(idOrSlug)}/version${qs ? `?${qs}` : ''}`;
  const data = (await fetchJson([`${API_OFFICIAL}${base}`, `${API_MIRROR}${base}`])) as RawVersion[];
  return (Array.isArray(data) ? data : []).map(toVersion).filter((v): v is ModVersionInfo => v !== null);
}

/** 单个版本详情（依赖安装用） */
async function getVersion(versionId: string): Promise<ModVersionInfo | null> {
  const data = (await fetchJson([
    `${API_OFFICIAL}/v2/version/${encodeURIComponent(versionId)}`,
    `${API_MIRROR}/v2/version/${encodeURIComponent(versionId)}`,
  ])) as RawVersion;
  return toVersion(data);
}

export function modsDir(gameDir = resolveGameDir()): string {
  return path.join(gameDir, 'mods');
}

/** 已安装模组（.jar / .jar.disabled） */
export function listInstalledMods(gameDir = resolveGameDir()): InstalledMod[] {
  const dir = modsDir(gameDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: InstalledMod[] = [];
  for (const fileName of names) {
    const enabled = fileName.endsWith('.jar');
    const disabled = fileName.endsWith('.jar.disabled');
    if (!enabled && !disabled) continue;
    try {
      const st = fs.statSync(path.join(dir, fileName));
      out.push({
        fileName,
        name: fileName.replace(/\.jar(\.disabled)?$/, ''),
        size: st.size,
        enabled,
      });
    } catch {
      // 忽略
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 下载单个模组文件（镜像优先 → 官方） */
async function downloadModFile(file: ModFile, gameDir: string): Promise<{ ok: boolean; error: string }> {
  const dir = modsDir(gameDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.filename);
  const mirrorUrl = file.url.startsWith(CDN_OFFICIAL)
    ? CDN_MIRROR + file.url.slice(CDN_OFFICIAL.length)
    : '';
  const candidates = [
    { sourceId: '1b1t-mirror', url: mirrorUrl },
    { sourceId: 'modrinth', url: file.url },
  ].filter((c) => c.url);
  const task: ResourceFile = {
    key: `mod:${file.filename}`,
    name: file.filename,
    path: dest,
    candidates,
    sha1: file.sha1,
    size: file.size,
  };
  const res = await runDownloads([task], { onProgress: () => undefined });
  if (res.failed.length > 0) {
    return { ok: false, error: res.failed[0]?.error || '下载失败' };
  }
  return { ok: true, error: '' };
}

/** 安装模组（可指定版本；默认取最新适配版本），并自动装必需依赖 */
export async function installMod(opts: {
  idOrSlug: string;
  versionId?: string;
  mcVersion: string;
  loader: string;
}): Promise<{ ok: boolean; error: string; fileName: string; dependencies: number }> {
  const gameDir = resolveGameDir();
  let version = opts.versionId ? await getVersion(opts.versionId) : null;
  if (!version) {
    const list = await listModVersions(opts.idOrSlug, opts.mcVersion, opts.loader);
    version = list[0] ?? null;
  }
  if (!version) {
    return {
      ok: false,
      error: `没有适配 MC ${opts.mcVersion} / ${opts.loader} 的版本`,
      fileName: '',
      dependencies: 0,
    };
  }
  const first = await downloadModFile(version.file, gameDir);
  if (!first.ok) return { ok: false, error: first.error, fileName: '', dependencies: 0 };

  // 必需依赖（递归 3 层，避免循环）
  let deps = 0;
  const seen = new Set<string>([version.id]);
  const installDeps = async (list: ModVersionInfo[], depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const v of list) {
      for (const dep of v.dependencies) {
        if (!dep.versionId || seen.has(dep.versionId)) continue;
        seen.add(dep.versionId);
        const dv = await getVersion(dep.versionId).catch(() => null);
        if (!dv) continue;
        const r = await downloadModFile(dv.file, gameDir);
        if (r.ok) deps += 1;
        await installDeps([dv], depth + 1);
      }
    }
  };
  await installDeps([version], 0).catch(() => undefined);
  return { ok: true, error: '', fileName: version.file.filename, dependencies: deps };
}

interface RawFileVersion {
  id?: string;
  project_id?: string;
}

/**
 * 检查已装模组更新：用 jar 的 SHA1 反查 Modrinth version_file，再按当前 MC 版本/加载器取最新。
 * 缺失/非 Modrinth 来源的模组计入 unknown。
 */
export async function checkModUpdates(
  mcVersion: string,
  loader: string,
): Promise<{ updates: ModUpdate[]; checked: number; unknown: number }> {
  const dir = modsDir();
  const files = listInstalledMods().filter((m) => m.enabled);
  const updates: ModUpdate[] = [];
  let unknown = 0;
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const sha1 = await sha1File(path.join(dir, item.fileName));
        if (!sha1) {
          unknown += 1;
          continue;
        }
        const raw = (await fetchJson([
          `${API_OFFICIAL}/v2/version_file/${sha1}?algorithm=sha1`,
          `${API_MIRROR}/v2/version_file/${sha1}?algorithm=sha1`,
        ])) as RawFileVersion;
        const projectId = raw.project_id ?? '';
        const currentId = raw.id ?? '';
        if (!projectId) {
          unknown += 1;
          continue;
        }
        const list = await listModVersions(projectId, mcVersion, loader);
        const latest = list.find((v) => v.id !== currentId);
        if (latest && latest.id !== currentId) {
          updates.push({
            fileName: item.fileName,
            projectId,
            currentVersionId: currentId,
            latestVersionId: latest.id,
            latestFileName: latest.file.filename,
            latestUrl: latest.file.url,
            latestSha1: latest.file.sha1,
            latestSize: latest.file.size,
          });
        }
      } catch {
        unknown += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, files.length)) }, () => worker()));
  return { updates, checked: files.length, unknown };
}

/** 应用单个模组更新：下载新文件 → 删除旧文件 */
export async function applyModUpdate(
  oldFileName: string,
  file: ModFile,
): Promise<{ ok: boolean; error: string; newFileName: string }> {
  const gameDir = resolveGameDir();
  const r = await downloadModFile(file, gameDir);
  if (!r.ok) return { ok: false, error: r.error, newFileName: '' };
  if (oldFileName && oldFileName !== file.filename) {
    try {
      fs.unlinkSync(path.join(modsDir(gameDir), oldFileName));
    } catch {
      // 旧文件不存在/删除失败不影响新文件
    }
  }
  return { ok: true, error: '', newFileName: file.filename };
}

/** 启用 / 禁用模组（改后缀） */
export function setModEnabled(fileName: string, enabled: boolean): { ok: boolean; error: string } {
  const dir = modsDir();
  const src = path.join(dir, fileName);
  const baseName = fileName.replace(/\.jar(\.disabled)?$/, '');
  const dst = path.join(dir, enabled ? `${baseName}.jar` : `${baseName}.jar.disabled`);
  try {
    if (!fs.existsSync(src)) return { ok: false, error: '文件不存在' };
    if (src !== dst) fs.renameSync(src, dst);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 删除模组 */
export function deleteMod(fileName: string): { ok: boolean; error: string } {
  try {
    fs.unlinkSync(path.join(modsDir(), fileName));
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
