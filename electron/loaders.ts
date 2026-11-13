// 模组加载器与基础 API：版本列表拉取、安装部署（下载+生成改造版 version json）、API mod 部署
// 资源 URL 规则（源链：1b1t 镜像 → BMCLAPI → 官方兜底）：
//   fabric-meta / quilt-meta：<root>/fabric-meta/<官方 path> | <root>/quilt-meta/<官方 path>
//   maven 库（fabric/forge/neoforge/quilt）：<root>/maven/<官方 maven path>（BMCLAPI 聚合规则，镜像同构）
//   Modrinth（API mod）：<root>/modrinth/<官方 path>（镜像同构），官方兜底 api.modrinth.com
//   root = baseUrl 去掉 /bmclapi2.bangbang93.com 尾（BMCLAPI 源 root = 其自身域名）
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadJava, pickJava, requiredJavaMajor, scanJava } from './java';
import { httpDownload } from './http';
import { runDownloads, type ResourceFile } from './downloader';
import { bmclapiUrl, getClientSourceChain } from './sources';
import { extractZip } from './zip';
import type { LoaderKind, LoaderVersions, SourceDef } from './types';
import { libraryPathFromName, type ParsedVersion } from './versions';

/** 源根：自有镜像 baseUrl 去 /bmclapi2.bangbang93.com 尾；BMCLAPI 自身域名保留 */
function sourceRoot(source: SourceDef): string {
  const base = source.baseUrl.replace(/\/+$/, '');
  if (base === 'https://bmclapi2.bangbang93.com') return base;
  return base.replace(/\/bmclapi2\.bangbang93\.com$/, '');
}

/** 加载器 meta/maven 的官方 URL 主机与镜像规则 */
const FABRIC_META_HOST = 'meta.fabricmc.net';
const QUILT_META_HOST = 'meta.quiltmc.org';
const MODRINTH_HOST = 'api.modrinth.com';

/** 生成某资源的候选 URL 列表（按源链顺序，最后加官方兜底） */
function candidates(
  pathOnMirror: string,
  officialUrl: string,
  hostRules: { hosts: string[]; prefix: string } | null,
): { sourceId: string; url: string }[] {
  const chain = getClientSourceChain();
  const out: { sourceId: string; url: string }[] = [];
  for (const s of chain) {
    if (s.protocol !== 'bmclapi') continue;
    const root = sourceRoot(s);
    if (hostRules) {
      const u = new URL(officialUrl);
      if (hostRules.hosts.includes(u.host)) {
        out.push({ sourceId: s.id, url: `${root}${hostRules.prefix}${u.pathname}${u.search}` });
        continue;
      }
    }
    out.push({ sourceId: s.id, url: `${root}${pathOnMirror}` });
  }
  // 官方兜底（自动模式最后一跳）
  out.push({ sourceId: 'official-loader', url: officialUrl });
  return out;
}

/** 拉取 meta JSON：镜像源用 index.json 约定（列表文件），BMCLAPI/官方用同构路径 */
async function fetchMeta(
  suffix: string,
  officialUrl: string,
  mirrorSuffix: string | null,
): Promise<string> {
  const out: { sourceId: string; url: string }[] = [];
  const chain = getClientSourceChain();
  for (const csrc of chain) {
    if (csrc.protocol !== 'bmclapi') continue;
    const root = sourceRoot(csrc);
    const isBmclapi = csrc.baseUrl.includes('bmclapi2.bangbang93.com');
    // 自有镜像（1b1t 等）：列表文件落盘为 <路径>/index.json；BMCLAPI：官方同构路径
    const url = isBmclapi || mirrorSuffix === null ? `${root}${suffix}` : `${root}${mirrorSuffix}`;
    out.push({ sourceId: csrc.id, url });
  }
  out.push({ sourceId: 'official-loader', url: officialUrl });
  let lastErr = '无可用资源源';
  for (const c of out) {
    const tmp = path.join(os.tmpdir(), `mcore-meta-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    try {
      const r = await httpDownload(c.url, tmp, { timeoutMs: 10000 });
      if (r.ok) {
        return fs.readFileSync(tmp, 'utf-8');
      }
      lastErr = `${c.sourceId}: ${r.error}`;
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

interface FabricLoaderEntry {
  loader: { version: string; stable?: boolean };
}
interface QuiltLoaderEntry {
  loader: { version: string };
}

/** 从源拉取加载器实际资源索引（/maven/<kind>-index.json，同步任务生成；资源有多少展示多少） */
async function fetchLoaderIndex(kind: string): Promise<string[] | null> {
  const chain = getClientSourceChain();
  for (const s of chain) {
    if (s.protocol !== 'bmclapi') continue;
    const root = sourceRoot(s);
    const tmp = path.join(os.tmpdir(), `mcore-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    try {
      const r = await httpDownload(`${root}/maven/${kind}-index.json`, tmp, { timeoutMs: 8000 });
      if (r.ok) {
        const arr = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as string[];
        if (Array.isArray(arr)) return arr;
      }
    } catch {
      // 下一候选
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 忽略
      }
    }
  }
  return null;
}

/** 拉取全部加载器版本列表：优先私有源实际资源索引，索引不可达时降级 meta API */
export async function listLoaders(mcVersion: string): Promise<LoaderVersions[]> {
  const [fabricIdx, quiltIdx, forgeIdx, neoIdx] = await Promise.all([
    fetchLoaderIndex('fabric'),
    fetchLoaderIndex('quilt'),
    fetchLoaderIndex('forge'),
    fetchLoaderIndex('neoforge'),
  ]);

  // Forge 索引版本号 = <mc>-<loaderVer>；NeoForge = <世代>.<minor>.<patch>（如 21.1.255）
  const mcm = mcVersion.match(/^\d+\.(\d+)\.(\d+)/);
  const neoPrefix = mcm ? `${mcm[1]}.${mcm[2]}.` : '';

  const results = await Promise.allSettled([
    (async (): Promise<LoaderVersions> => {
      if (fabricIdx !== null) {
        // 私有源实际资源：loader 版本跨 MC 通用，直接展示
        return { kind: 'fabric', versions: fabricIdx.map((v) => ({ version: v, stable: true })).reverse() };
      }
      const raw = await fetchMeta(
        `/fabric-meta/v2/versions/loader/${mcVersion}`,
        `https://${FABRIC_META_HOST}/v2/versions/loader/${mcVersion}`,
        `/fabric-meta/v2/versions/loader/${mcVersion}/index.json`,
      );
      const arr = JSON.parse(raw) as FabricLoaderEntry[];
      return {
        kind: 'fabric',
        versions: arr
          .filter((e) => e?.loader?.version)
          .map((e) => ({ version: e.loader.version, stable: e.loader.stable !== false })),
      };
    })(),
    (async (): Promise<LoaderVersions> => {
      if (quiltIdx !== null) {
        return { kind: 'quilt', versions: quiltIdx.map((v) => ({ version: v, stable: true })).reverse() };
      }
      const raw = await fetchMeta(
        `/quilt-meta/v3/versions/loader/${mcVersion}`,
        `https://${QUILT_META_HOST}/v3/versions/loader/${mcVersion}`,
        `/quilt-meta/v3/versions/loader/${mcVersion}/index.json`,
      );
      const arr = JSON.parse(raw) as QuiltLoaderEntry[];
      return {
        kind: 'quilt',
        versions: arr.filter((e) => e?.loader?.version).map((e) => ({ version: e.loader.version, stable: true })),
      };
    })(),
    (async (): Promise<LoaderVersions> => {
      if (forgeIdx !== null) {
        const vers = forgeIdx
          .filter((v) => v.startsWith(`${mcVersion}-`))
          .map((v) => ({ version: v.slice(mcVersion.length + 1), stable: true }))
          .reverse();
        return { kind: 'forge', versions: vers };
      }
      const raw = await fetchForgeVersions(mcVersion);
      return { kind: 'forge', versions: raw };
    })(),
    (async (): Promise<LoaderVersions> => {
      if (neoIdx !== null) {
        const vers = neoIdx
          .filter((v) => v.startsWith(neoPrefix))
          .map((v) => ({ version: v, stable: true }))
          .reverse();
        return { kind: 'neoforge', versions: vers };
      }
      const raw = await fetchForgeVersions(mcVersion, true);
      return { kind: 'neoforge', versions: raw };
    })(),
  ]);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { kind: 'fabric' as LoaderKind, versions: [] }));
}

/** Forge / NeoForge 版本列表（官方 maven metadata，BMCLAPI 镜像数据陈旧不可用） */
export async function fetchForgeVersions(mcVersion: string, neo = false): Promise<{ version: string; stable: boolean }[]> {
  const url = neo
    ? 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
    : 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
  const tmp = path.join(os.tmpdir(), `mcore-fm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xml`);
  try {
    let r = await httpDownload(url, tmp, { timeoutMs: 15000 });
    if (!r.ok) r = await httpDownload(url, tmp, { timeoutMs: 15000 }); // 网络瞬时失败重试一次
    if (!r.ok) return [];
    const xml = fs.readFileSync(tmp, 'utf-8');
    const versions = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), (m) => m[1]);
    if (neo) {
      // NeoForge 版本号 = <mcMajor>.<mcMinor>.<patch>（无 MC 前缀）
      const m = mcVersion.match(/^\d+\.(\d+)\.(\d+)/);
      const prefix = m ? `${m[1]}.${m[2]}.` : '';
      return versions
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ version: v, stable: true }))
        .reverse();
    }
    return versions
      .filter((v) => v.startsWith(`${mcVersion}-`))
      .map((v) => ({ version: v.slice(mcVersion.length + 1), stable: true }))
      .reverse();
  } catch {
    return [];
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

/** maven 坐标 → 官方 maven 路径（group:artifact:version[:classifier] → path） */
export function mavenPath(coord: string): string {
  const [group, artifact, version, classifier] = coord.split(':');
  const base = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}`;
  return classifier ? `${base}-${classifier}.jar` : `${base}.jar`;
}

/** maven 坐标 → 官方 URL（fabric/forge/neoforge 用各自 maven 域） */
function mavenOfficialUrl(coord: string, host: string, prefix = ''): string {
  return `https://${host}${prefix}/${mavenPath(coord)}`;
}

/** 下载单个 maven 库（候选：镜像 /maven 聚合 → BMCLAPI /maven → 官方域名） */
function mavenCandidates(
  coord: string,
  hosts: string[],
  prefixes: Partial<Record<string, string>>,
  officialBase?: string,
): { sourceId: string; url: string }[] {
  const pathPart = mavenPath(coord);
  const officialUrl = officialBase
    ? `${officialBase}/${pathPart}`
    : mavenOfficialUrl(coord, hosts[0], prefixes[hosts[0]] ?? '');
  const chain = getClientSourceChain();
  const out: { sourceId: string; url: string }[] = [];
  for (const s of chain) {
    if (s.protocol !== 'bmclapi') continue;
    const root = sourceRoot(s);
    out.push({ sourceId: s.id, url: `${root}/maven/${pathPart}` });
  }
  out.push({ sourceId: 'official-loader', url: officialUrl });
  return out;
}

/**
 * 安装 Fabric / Quilt 加载器：
 * 拉 loader meta → 生成改造版 version json（mainClass 替换 + libraries 追加）→ 下载全部库
 * 返回改造版 versionId
 */
async function installFabricLike(
  kind: 'fabric' | 'quilt',
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
): Promise<string> {
  const metaUrl =
    kind === 'fabric'
      ? `https://${FABRIC_META_HOST}/v2/versions/loader/${mcVersion}/${loaderVersion}`
      : `https://${QUILT_META_HOST}/v3/versions/loader/${mcVersion}/${loaderVersion}`;
  const metaSuffix =
    kind === 'fabric'
      ? `/fabric-meta/v2/versions/loader/${mcVersion}/${loaderVersion}`
      : `/quilt-meta/v3/versions/loader/${mcVersion}/${loaderVersion}`;
  const raw = await fetchMeta(metaSuffix, metaUrl, null);
  const meta = JSON.parse(raw) as {
    loader: { version: string; maven?: string };
    intermediary?: { maven?: string };
    launcherMeta?: {
      mainClass?: { client?: string };
      libraries?: { name: string; url?: string }[] | { common?: { name: string }[]; client?: { name: string }[] };
    };
  };

  const newId = `${mcVersion}-${kind}-loader-${loaderVersion}`;
  const newDir = path.join(gameDir, 'versions', newId);

  // 基于原版 json 克隆改造
  const vanillaPath = path.join(gameDir, 'versions', mcVersion, `${mcVersion}.json`);
  if (!fs.existsSync(vanillaPath)) {
    throw new Error(`原版版本未安装: ${mcVersion}`);
  }
  const vanilla = JSON.parse(fs.readFileSync(vanillaPath, 'utf-8')) as ParsedVersion;

  const mainClass = meta.launcherMeta?.mainClass?.client;
  if (!mainClass) throw new Error('加载器 meta 缺少主类');

  const extraLibs: { name: string; url?: string }[] = [];
  const lmLibs = meta.launcherMeta?.libraries;
  const lmList: { name: string; url?: string }[] = Array.isArray(lmLibs)
    ? (lmLibs as { name: string; url?: string }[])
    : [...(lmLibs?.common ?? []), ...(lmLibs?.client ?? [])];
  for (const lib of lmList) {
    if (lib.name) extraLibs.push({ name: lib.name, url: lib.url });
  }
  if (meta.intermediary?.maven) extraLibs.push({ name: meta.intermediary.maven });
  if (meta.loader?.maven) extraLibs.push({ name: meta.loader.maven });

  // 追加库补上 downloads.artifact（仅 name 的库在启动 classpath/资源校验里会被漏掉）
  const extraLibEntries = extraLibs.map((l) => ({
    name: l.name,
    downloads: {
      artifact: {
        path: libraryPathFromName(l.name),
        url: l.url ?? '',
        sha1: '',
        size: 0,
      },
    },
  }));
  const modified: ParsedVersion = {
    ...vanilla,
    id: newId,
    mainClass,
    libraries: [...(vanilla.libraries ?? []), ...extraLibEntries],
  };

  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, `${newId}.json`), JSON.stringify(modified, null, 2), 'utf-8');

  // 下载新增库
  const files: ResourceFile[] = [];
  const hosts = kind === 'fabric' ? ['maven.fabricmc.net'] : ['maven.quiltmc.org'];
  const prefixes = kind === 'fabric' ? { 'maven.fabricmc.net': '' } : { 'maven.quiltmc.org': '/repository/release' };
  for (const lib of extraLibs) {
    const rel = mavenPath(lib.name);
    const officialBase = lib.url
      ? lib.url.replace(/\/$/, '')
      : kind === 'fabric'
        ? 'https://maven.fabricmc.net'
        : 'https://maven.quiltmc.org/repository/release';
    files.push({
      key: `loaderlib:${lib.name}`,
      name: lib.name,
      path: path.join(gameDir, 'libraries', rel),
      candidates: mavenCandidates(lib.name, hosts, prefixes, officialBase),
      sha1: '',
      size: 0,
    });
  }
  await runDownloads(files, { onProgress: () => undefined });

  return newId;
}

/**
 * 安装 Forge / NeoForge：
 * 下载 installer jar → 提取 install_profile.json 的 versionInfo（即改造版 version json）
 * → 写入版本目录 → 下载全部 libraries
 */
/** maven 坐标（可带 @ext）→ 库相对路径 */
function coordPath(coord: string): string {
  const [name, extRaw] = coord.split('@');
  const ext = extRaw || 'jar';
  const parts = name.split(':');
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return '';
  const base = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}`;
  return classifier ? `${base}-${classifier}.${ext}` : `${base}.${ext}`;
}

/**
 * B 方案前置：把安装器与运行库预灌进 libraries/（1B1T 镜像 → BMCLAPI maven → 官方）。
 * 官方 installer 会跳过已存在文件，因此即使 maven.neoforged.net 不可达也能装完。
 */
async function seedForgeLibraries(
  kind: 'forge' | 'neoforge',
  profile: {
    libraries?: { name?: string; downloads?: { artifact?: { path?: string; url?: string } } }[];
    processors?: { jar?: string; classpath?: string[] }[];
  },
  vi: ParsedVersion,
  gameDir: string,
): Promise<void> {
  const chain = getClientSourceChain().filter((s) => s.protocol === 'bmclapi');
  const officialMaven = kind === 'forge' ? 'https://maven.minecraftforge.net' : 'https://maven.neoforged.net/releases';
  const byPath = new Map<string, ResourceFile>();

  const add = (pathPart: string, officialUrl: string, name: string): void => {
    if (!pathPart || byPath.has(pathPart)) return;
    const cands = chain.map((s) => {
      const base = s.baseUrl.replace(/\/+$/, '');
      const root = base === 'https://bmclapi2.bangbang93.com' ? base : base.replace(/\/bmclapi2\.bangbang93\.com$/, '');
      return { sourceId: s.id, url: `${root}/maven/${pathPart}` };
    });
    // 公共 maven 兜底（nashorn 等不属于 MC/加载器域的依赖）
    cands.push({ sourceId: 'aliyun', url: `https://maven.aliyun.com/repository/public/${pathPart}` });
    cands.push({ sourceId: 'maven-central', url: `https://repo1.maven.org/maven2/${pathPart}` });
    if (officialUrl) cands.push({ sourceId: 'official', url: officialUrl });
    byPath.set(pathPart, {
      key: `forge-seed:${pathPart}`,
      name,
      path: path.join(gameDir, 'libraries', pathPart),
      candidates: cands,
      sha1: '',
      size: 0,
    });
  };

  // 安装器自身依赖（installertools / jarsplitter / AutoRenamingTool / binarypatcher ...）
  for (const p of profile.processors ?? []) {
    for (const coord of [p.jar ?? '', ...(p.classpath ?? [])]) {
      if (!coord) continue;
      const pp = mavenPath(coord);
      if (pp) add(pp, `${officialMaven}/${pp}`, coord);
    }
  }
  // install_profile.libraries（含 neoform zip / universal 等，坐标可能带 @ext）
  for (const lib of profile.libraries ?? []) {
    const coord = lib.name ?? '';
    const pp = lib.downloads?.artifact?.path || coordPath(coord);
    if (!pp) continue;
    const official = lib.downloads?.artifact?.url || (coord.includes('@zip') ? `${officialMaven}/${pp}` : `${officialMaven}/${pp}`);
    add(pp, official, coord || pp);
  }
  // 版本运行库（安装器同样会检查这些）
  for (const lib of vi.libraries ?? []) {
    const artifact = lib.downloads?.artifact;
    const pp = artifact?.path;
    if (!pp) continue;
    const official = artifact?.url ?? '';
    add(pp, official, lib.name);
  }

  const files = Array.from(byPath.values());
  if (files.length > 0) {
    await runDownloads(files, { onProgress: () => undefined });
    // 安装器会校验本地库；缺任何依赖都会去连官方 maven（可能被墙），提前报清楚
    const missing = files.filter((f) => !fs.existsSync(f.path)).map((f) => f.name);
    if (missing.length > 0) {
      throw new Error(
        `加载器依赖下载失败：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}`,
      );
    }
  }
}

/** 运行官方加载器安装器（java -jar installer.jar --installClient <gameDir>），返回日志 */
function runInstaller(javaPath: string, installerPath: string, gameDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', installerPath, '--installClient', gameDir], {
      cwd: gameDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const append = (d: Buffer) => {
      out += d.toString('utf-8');
      if (out.length > 300000) out = out.slice(-150000);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 忽略
      }
      reject(new Error('安装器执行超时（15 分钟）'));
    }, 15 * 60 * 1000);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`安装器退出码 ${code}：${out.slice(-600).trim()}`));
    });
  });
}

async function installForgeLike(
  kind: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
): Promise<string> {
  // Forge 版本号 = <mc>-<loaderVer>；NeoForge 版本号本身已含 MC 世代（如 21.1.255）
  const fullVer = kind === 'forge' ? `${mcVersion}-${loaderVersion}` : loaderVersion;
  const mavenCoord =
    kind === 'forge' ? `net.minecraftforge:forge:${fullVer}:installer` : `net.neoforged:neoforge:${fullVer}:installer`;
  // NeoForge 官方路径带 /releases 前缀，BMCLAPI 聚合路径同样（实测）
  const installerTmp = path.join(os.tmpdir(), `mcore-inst-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jar`);
  try {
    const cands =
      kind === 'forge'
        ? mavenCandidates(mavenCoord, ['maven.minecraftforge.net'], { 'maven.minecraftforge.net': '' })
        : mavenCandidates(mavenCoord, ['maven.neoforged.net'], { 'maven.neoforged.net': '/releases' });
    let ok = false;
    for (const c of cands) {
      const r = await httpDownload(c.url, installerTmp, { timeoutMs: 20000 });
      if (r.ok) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new Error(`${kind} installer 下载失败`);

    // 提取 install_profile.json
    const extractDir = path.join(os.tmpdir(), `mcore-inst-x-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(extractDir, { recursive: true });
    extractZip(installerTmp, extractDir, []);
    const profilePath = path.join(extractDir, 'install_profile.json');
    if (!fs.existsSync(profilePath)) throw new Error('installer 内缺少 install_profile.json');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as {
      versionInfo?: ParsedVersion;
      json?: string;
      libraries?: { name?: string; downloads?: { artifact?: { path?: string; url?: string } } }[];
      processors?: { jar?: string; classpath?: string[] }[];
    };
    // 新版 Forge：versionInfo 在 installer 内 json 字段指向的文件（如 /version.json）
    let vi = profile.versionInfo;
    if (!vi && profile.json) {
      const viPath = path.join(extractDir, profile.json.replace(/^\//, ''));
      if (fs.existsSync(viPath)) {
        vi = JSON.parse(fs.readFileSync(viPath, 'utf-8')) as ParsedVersion;
      }
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (!vi?.id) throw new Error('install_profile 缺少 versionInfo');
    const expectedId = vi.id;

    // 预灌安装器依赖与运行库（镜像优先），避免官方 installer 直连被墙的 maven.neoforged.net
    await seedForgeLibraries(kind, profile, vi, gameDir);

    // 官方安装器要求存在 launcher_profiles.json（首次使用本启动器的目录需要补一个桩）
    const profilesPath = path.join(gameDir, 'launcher_profiles.json');
    if (!fs.existsSync(profilesPath)) {
      fs.mkdirSync(gameDir, { recursive: true });
      fs.writeFileSync(profilesPath, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf-8');
    }

    // 安装器需要匹配的 Java（同时负责跑 processors、下载官方库）
    const required = requiredJavaMajor(mcVersion, undefined);
    const runtimes = await scanJava();
    let javaPath = pickJava(runtimes, required)?.path ?? '';
    if (!javaPath) {
      const installed = await downloadJava(required, () => undefined);
      javaPath = installed?.path ?? '';
    }
    if (!javaPath) throw new Error(`需要 Java ${required} 才能运行 ${kind} 安装器，自动安装也失败`);

    // 直接调官方安装器（--installClient）：install_profile + processors 全部由官方逻辑完成
    await runInstaller(javaPath, installerTmp, gameDir);

    // 安装器写出的版本目录（Forge: <mc>-forge-<ver>；NeoForge: neoforge-<ver>）
    const installedJson = path.join(gameDir, 'versions', expectedId, `${expectedId}.json`);
    let newId = expectedId;
    if (!fs.existsSync(installedJson)) {
      // 兜底：安装器可能用了不同 id，扫描最近写入的版本目录
      const versionsDir = path.join(gameDir, 'versions');
      const candidates = fs.existsSync(versionsDir)
        ? fs
            .readdirSync(versionsDir)
            .map((n) => ({ n, m: fs.statSync(path.join(versionsDir, n)).mtimeMs }))
            .sort((a, b) => b.m - a.m)
        : [];
      const hit = candidates.find((c) => fs.existsSync(path.join(versionsDir, c.n, `${c.n}.json`)) && c.n !== mcVersion);
      if (!hit) throw new Error(`${kind} 安装器执行完成但未生成版本目录（${expectedId}）`);
      newId = hit.n;
    }
    return newId;
  } finally {
    try {
      fs.unlinkSync(installerTmp);
    } catch {
      // 忽略
    }
  }
}

/** 安装加载器：返回改造版 versionId（原版 json 必须已存在） */
export async function installLoader(
  kind: LoaderKind,
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
): Promise<string> {
  if (kind === 'fabric' || kind === 'quilt') {
    return installFabricLike(kind, mcVersion, loaderVersion, gameDir);
  }
  return installForgeLike(kind, mcVersion, loaderVersion, gameDir);
}

/** API mod 列表（Modrinth 项目 → 版本文件 URL）；候选：镜像 /modrinth 聚合 → 官方 */
export async function fetchApiMod(slug: string, mcVersion: string, loader: string): Promise<{ url: string; name: string }> {
  const apiUrl = `https://${MODRINTH_HOST}/v2/project/${slug}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
  const tmp = path.join(os.tmpdir(), `mcore-api-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    const cands = candidates(`/modrinth/v2/project/${slug}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`, apiUrl, null);
    let raw = '';
    for (const c of cands) {
      const r = await httpDownload(c.url, tmp, { timeoutMs: 15000 });
      if (r.ok) {
        raw = fs.readFileSync(tmp, 'utf-8');
        break;
      }
    }
    if (!raw) throw new Error('API mod 版本列表拉取失败');
    const arr = JSON.parse(raw) as { files?: { url: string; filename: string; primary?: boolean }[] }[];
    for (const v of arr) {
      const primary = v.files?.find((f) => f.primary) ?? v.files?.[0];
      if (primary?.url) {
        return { url: primary.url, name: primary.filename };
      }
    }
    throw new Error('API mod 无可用文件');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

/** 部署 API mod jar 到游戏目录 mods 文件夹（候选：镜像 /modrinth 聚合 → 官方直连） */
export async function installApiMod(
  officialUrl: string,
  fileName: string,
  mcVersion: string,
  gameDir: string,
): Promise<void> {
  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, fileName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;

  const u = new URL(officialUrl);
  const mirrorPath = `/modrinth${u.pathname}`;
  const cands = candidates(mirrorPath, officialUrl, null);
  const file: ResourceFile = {
    key: `api:${fileName}`,
    name: fileName,
    path: dest,
    candidates: cands,
    sha1: '',
    size: 0,
  };
  await runDownloads([file], { onProgress: () => undefined });
}
