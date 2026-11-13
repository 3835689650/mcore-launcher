// 版本管理：version_manifest 拉取、version json 解析、资源清单生成（多源候选 URL）
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { httpDownload } from './http';
import { bmclapiUrl, getClientSourceChain, probeUrl } from './sources';
import { runDownloads, sha1File } from './downloader';
import type { ResourceFile } from './downloader';
import type { VersionManifestEntry } from './types';

/** version.json 相关结构（存在什么读什么，缺失字段跳过） */
export interface ArtifactInfo {
  path?: string;
  url?: string;
  sha1?: string;
  size?: number;
}

export interface LibraryEntry {
  name: string;
  downloads?: {
    artifact?: ArtifactInfo;
    classifiers?: Record<string, ArtifactInfo>;
  };
  natives?: Record<string, string>;
  rules?: RuleEntry[];
  extract?: { exclude?: string[] };
}

export interface RuleEntry {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string };
  features?: Record<string, boolean>;
}

export interface ArgumentEntry {
  rules?: RuleEntry[];
  value: string | string[];
}

/** arguments 数组条目：{rules, value} 对象或纯字符串（真实 json 为混合格式） */
export type ArgumentItem = string | ArgumentEntry;

export interface ParsedVersion {
  id: string;
  type: string;
  mainClass?: string;
  minecraftArguments?: string;
  arguments?: { game?: ArgumentItem[]; jvm?: ArgumentItem[] };
  libraries?: LibraryEntry[];
  downloads?: { client?: ArtifactInfo };
  assetIndex?: { id?: string; url?: string; sha1?: string; size?: number };
  assets?: string;
  javaVersion?: { majorVersion?: number };
  inheritsFrom?: string;
  /** 合并 inheritsFrom 后客户端核心 jar 实际所属的版本 id（Forge/NeoForge 为父版本） */
  jarId?: string;
}

/** 平台 OS 名（MC 规则里用） */
export function osName(): string {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

/** 特性集：精简版启动器不开放自定义分辨率，has_custom_resolution 恒为 false */
const FEATURES: Record<string, boolean> = { has_custom_resolution: false };

/** MC 规则里的 CPU 架构名（与 json 中 os.arch 字段对应） */
function mcArch(): string {
  switch (process.arch) {
    case 'x64':
      return 'x86_64';
    case 'ia32':
      return 'x86';
    case 'arm64':
      return 'arm64';
    default:
      return process.arch;
  }
}

/** 规则过滤：存在 rules 时逐条求值，命中第一条生效；无 rules 默认包含 */
export function applyRules(rules: RuleEntry[] | undefined): boolean {
  if (!rules || rules.length === 0) return true;
  // 官方语义：逐条求值，最后一条命中的规则决定结果；有 rules 但一条都不命中 → 不包含
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os?.name && r.os.name !== osName()) match = false;
    if (r.os?.arch && r.os.arch !== mcArch()) match = false;
    if (r.features) {
      for (const k of Object.keys(r.features)) {
        if ((FEATURES[k] ?? false) !== r.features[k]) match = false;
      }
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

/** 参数过滤：把 arguments 数组过滤并扁平化为字符串列表（缺失字段直接跳过；支持纯字符串条目） */
export function flattenArguments(items: ArgumentItem[] | undefined): string[] {
  const out: string[] = [];
  if (!items) return out;
  for (const item of items) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (!item || !applyRules(item.rules)) continue;
    if (typeof item.value === 'string') out.push(item.value);
    else if (Array.isArray(item.value)) out.push(...item.value);
    // value 缺失或类型异常 → 跳过
  }
  return out;
}

/** 从 library name（group:artifact:version）推导默认路径（无 downloads 字段时兜底） */
export function libraryPathFromName(name: string): string {
  const [group, artifact, version] = name.split(':');
  if (!group || !artifact || !version) return '';
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
}

/** 拉取 version_manifest：按当前源链顺序尝试，返回首个可用源的清单 */
export async function fetchManifest(): Promise<{ entries: VersionManifestEntry[]; sourceId: string }> {
  const chain = getClientSourceChain();
  let lastErr = '无可用资源源';
  for (const source of chain) {
    const url = probeUrl(source);
    const dest = path.join(os.tmpdir(), `mcore-manifest-${process.pid}.json`);
    try {
      const r = await httpDownload(url, dest, { timeoutMs: 10000 });
      if (r.ok) {
        const raw = fs.readFileSync(dest, 'utf-8');
        const parsed = JSON.parse(raw) as { versions?: VersionManifestEntry[] };
        if (parsed && Array.isArray(parsed.versions)) {
          return { entries: parsed.versions, sourceId: source.id };
        }
        lastErr = '清单格式异常';
      } else {
        lastErr = `${source.name}: ${r.error}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    } finally {
      try {
        fs.unlinkSync(dest);
      } catch {
        // 忽略
      }
    }
  }
  throw new Error(lastErr);
}

/**
 * 下载指定版本 json（原始内容，不处理 inheritsFrom）。
 * official 协议：先拉 manifest 找到该 id 的原始 url；bmclapi：直接 /version/<id>/json
 */
async function fetchVersionJsonRaw(id: string, gameDir: string): Promise<{ json: ParsedVersion; sourceId: string }> {
  // 本地已安装优先：已装好的版本离线也能启动，不必每次联网重拉 json
  const local = readLocalVersion(id, gameDir);
  if (local?.id) return { json: local, sourceId: 'local' };
  const chain = getClientSourceChain();
  let lastErr = '无可用资源源';
  const localPath = path.join(gameDir, 'versions', id, `${id}.json`);

  for (const s of chain) {
    let url = '';
    if (s.protocol === 'official') {
      try {
        const { entries } = await fetchManifest();
        const hit = entries.find((e) => e.id === id);
        if (!hit) {
          lastErr = `${s.name}: 清单中无此版本`;
          continue;
        }
        url = hit.url;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        continue;
      }
    } else {
      url = bmclapiUrl(s, 'versionJson', id);
    }
    const tmp = `${localPath}.tmp-${process.pid}`;
    try {
      const r = await httpDownload(url, tmp, { timeoutMs: 10000 });
      if (r.ok) {
        const raw = fs.readFileSync(tmp, 'utf-8');
        const parsed = JSON.parse(raw) as ParsedVersion;
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, raw, 'utf-8');
        return { json: parsed, sourceId: s.id };
      }
      lastErr = `${s.name}: ${r.error}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 忽略
      }
    }
  }
  throw new Error(lastErr);
}

/** 读取本地已安装的版本 json */
function readLocalVersion(id: string, gameDir: string): ParsedVersion | null {
  try {
    const p = path.join(gameDir, 'versions', id, `${id}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as ParsedVersion;
  } catch {
    return null;
  }
}

/**
 * 合并 inheritsFrom 父版本（Forge / NeoForge / 部分整合包的版本 json 只含增量）：
 * 父库在前、子库在后；参数拼接；主类/下载信息/资产索引以子版本优先。
 */
function mergeVersionJson(parent: ParsedVersion, child: ParsedVersion): ParsedVersion {
  const pa = parent.arguments ?? {};
  const ca = child.arguments ?? {};
  return {
    ...parent,
    ...child,
    id: child.id,
    mainClass: child.mainClass ?? parent.mainClass,
    libraries: [...(parent.libraries ?? []), ...(child.libraries ?? [])],
    arguments: {
      game: [...(pa.game ?? []), ...(ca.game ?? [])],
      jvm: [...(pa.jvm ?? []), ...(ca.jvm ?? [])],
    },
    downloads: child.downloads ?? parent.downloads,
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    javaVersion: child.javaVersion ?? parent.javaVersion,
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    jarId: parent.jarId ?? parent.id,
  };
}

const MAX_INHERIT_DEPTH = 5;

/** 递归解析 inheritsFrom，返回可直接启动的完整版本 json */
export async function resolveInheritance(
  json: ParsedVersion,
  gameDir: string,
  seen: Set<string> = new Set(),
): Promise<ParsedVersion> {
  let cur = json;
  if (seen.has(cur.id)) return cur;
  seen.add(cur.id);
  for (let depth = 0; depth < MAX_INHERIT_DEPTH && cur.inheritsFrom; depth += 1) {
    const parentId = cur.inheritsFrom;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    let parent = readLocalVersion(parentId, gameDir);
    if (!parent) {
      try {
        parent = (await fetchVersionJsonRaw(parentId, gameDir)).json;
      } catch {
        break;
      }
    }
    const resolvedParent = await resolveInheritance(parent, gameDir, seen);
    cur = mergeVersionJson(resolvedParent, cur);
  }
  return cur;
}

/** 下载版本 json 并解析 inheritsFrom，返回可直接使用的完整 json */
export async function fetchVersionJson(id: string, gameDir: string): Promise<{ json: ParsedVersion; sourceId: string }> {
  const raw = await fetchVersionJsonRaw(id, gameDir);
  const json = await resolveInheritance(raw.json, gameDir);
  return { json, sourceId: raw.sourceId };
}

/** asset objects 官方源 URL（hash 寻址固定格式） */
function officialAssetUrl(h2: string, hash: string): string {
  return `https://resources.download.minecraft.net/${h2}/${hash}`;
}

/**
 * 生成版本完整资源下载清单（client jar / assetIndex / libraries / natives / assets objects），
 * 每个文件带全部候选源的 URL（按源链优先级排序）
 */
export async function buildResources(
  json: ParsedVersion,
  gameDir: string,
): Promise<ResourceFile[]> {
  const chain = getClientSourceChain();
  const files: ResourceFile[] = [];
  // inheritsFrom 场景下客户端核心属于父版本目录
  const jarId = json.jarId ?? json.id;
  const versionDir = path.join(gameDir, 'versions', jarId);

  // ---- 客户端核心 jar ----
  const clientArt = json.downloads?.client;
  if (clientArt) {
    const cands = chain.map((s) => ({
      sourceId: s.id,
      url: s.protocol === 'official' && clientArt.url ? clientArt.url : bmclapiUrl(s, 'clientJar', json.id),
    }));
    files.push({
      key: `client:${jarId}`,
      name: `${jarId} 客户端核心`,
      path: path.join(versionDir, `${jarId}.jar`),
      candidates: cands,
      sha1: clientArt.sha1 ?? '',
      size: clientArt.size ?? 0,
    });
  }

  // ---- assetIndex ----
  const ai = json.assetIndex;
  const aiId = ai?.id ?? '';
  const aiUrl = ai?.url ?? '';
  // 从 Mojang 原始 url 提取路径（/v1/packages/<hash>/<name>.json），镜像源同构
  let aiRel = '';
  if (aiUrl) {
    try {
      aiRel = new URL(aiUrl).pathname;
    } catch {
      aiRel = '';
    }
  }
  if (aiId) {
    const cands = chain.map((s) => ({
      sourceId: s.id,
      url:
        s.protocol === 'official' && aiUrl
          ? aiUrl
          : aiRel
            ? `${s.baseUrl.replace(/\/+$/, '')}${aiRel}`
            : '',
    }));
    files.push({
      key: `assetIndex:${aiId}`,
      name: `资产索引 ${aiId}`,
      path: path.join(gameDir, 'assets', 'indexes', `${aiId}.json`),
      candidates: cands,
      sha1: ai?.sha1 ?? '',
      size: ai?.size ?? 0,
    });
  }

  // ---- libraries（含 natives classifiers）----
  const nativesClassifier: string | null = (() => {
    for (const lib of json.libraries ?? []) {
      if (lib.natives && applyRules(lib.rules)) {
        const key = osName();
        const cls = lib.natives[key];
        if (cls) return cls;
      }
    }
    return null;
  })();

  for (const lib of json.libraries ?? []) {
    if (!applyRules(lib.rules)) continue;
    const artifact = lib.downloads?.artifact;
    if (artifact) {
      const relPath = artifact.path ?? libraryPathFromName(lib.name);
      if (relPath) {
        files.push({
          key: `lib:${lib.name}`,
          name: lib.name,
          path: path.join(gameDir, 'libraries', relPath),
          candidates: chain.map((s) => ({
            sourceId: s.id,
            url: s.protocol === 'official' && artifact.url ? artifact.url : bmclapiUrl(s, 'library', relPath),
          })),
          sha1: artifact.sha1 ?? '',
          size: artifact.size ?? 0,
        });
      }
    }
    // natives 分类文件
    if (lib.natives && nativesClassifier) {
      const cls = lib.natives[osName()];
      if (cls) {
        const info = lib.downloads?.classifiers?.[cls];
        if (info) {
          const relPath = info.path ?? '';
          if (relPath) {
            files.push({
              key: `lib:${lib.name}:${cls}`,
              name: `${lib.name} (${cls})`,
              path: path.join(gameDir, 'libraries', relPath),
              candidates: chain.map((s) => ({
                sourceId: s.id,
                url: s.protocol === 'official' && info.url ? info.url : bmclapiUrl(s, 'library', relPath),
              })),
              sha1: info.sha1 ?? '',
              size: info.size ?? 0,
            });
          }
        }
      }
    }
  }

  // ---- assets objects（读 assetIndex json 的 objects 字段；无该字段的远古格式直接跳过）----
  const aiTask = files.find((f) => f.key.startsWith('assetIndex:'));
  const aiPath = aiTask?.path;
  if (aiPath) {
    try {
      // assetIndex 需先下载才能解析 objects 清单（下载器已有完整/校验逻辑，重复下载会被跳过）
      const r = await runDownloads([aiTask], { onProgress: () => undefined });
      if (r.failed.length === 0) {
        const raw = fs.readFileSync(aiPath, 'utf-8');
        const parsed = JSON.parse(raw) as { objects?: Record<string, { hash: string; size: number }> };
        if (parsed.objects) {
          for (const [name, obj] of Object.entries(parsed.objects)) {
            if (!obj?.hash) continue;
            const h2 = obj.hash.slice(0, 2);
            files.push({
              key: `asset:${name}`,
              name: `资产 ${name}`,
              path: path.join(gameDir, 'assets', 'objects', h2, obj.hash),
              candidates: chain.map((s) => ({
                sourceId: s.id,
                url: s.protocol === 'official' ? officialAssetUrl(h2, obj.hash) : bmclapiUrl(s, 'asset', h2, obj.hash),
              })),
              sha1: obj.hash,
              size: obj.size ?? 0,
            });
          }
        }
      }
    } catch {
      // assetIndex 尚未下载或解析失败 → 跳过 objects，下次启动再补
    }
  }

  // 同一路径只保留一个下载任务（父/子版本重复库等），避免并发写同一文件
  const byPath = new Map<string, ResourceFile>();
  for (const file of files) {
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }
  return Array.from(byPath.values());
}

/** 校验版本是否已就位：客户端核心 jar（含哈希）+ 全部依赖库/natives 文件存在 */
export async function versionReady(json: ParsedVersion, gameDir: string): Promise<boolean> {
  const jarId = json.jarId ?? json.id;
  const jarPath = path.join(gameDir, 'versions', jarId, `${jarId}.jar`);
  try {
    if (!fs.existsSync(jarPath)) return false;
    const client = json.downloads?.client;
    // 大小精确匹配即可信任（避免每次启动都重算 40MB+ 的 SHA1）
    if (client?.size && fs.statSync(jarPath).size === client.size) {
      // 跳过哈希
    } else if (client?.sha1 && (await sha1File(jarPath)) !== client.sha1) {
      return false;
    }
    for (const lib of json.libraries ?? []) {
      if (!applyRules(lib.rules)) continue;
      const artifact = lib.downloads?.artifact;
      if (artifact?.path && !fs.existsSync(path.join(gameDir, 'libraries', artifact.path))) return false;
      const cls = lib.natives?.[osName()];
      if (cls) {
        const info = lib.downloads?.classifiers?.[cls];
        if (info?.path && !fs.existsSync(path.join(gameDir, 'libraries', info.path))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
