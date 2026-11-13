// 模组加载器资源同步到私有镜像（与启动器 URL 规则同构）：
//   <镜像>/fabric-meta/v2/...          ← meta.fabricmc.net
//   <镜像>/quilt-meta/v3/...           ← meta.quiltmc.org
//   <镜像>/maven/<官方 maven path>     ← maven.fabricmc.net / maven.minecraftforge.net / maven.neoforged.net / maven.quiltmc.org
//   <镜像>/modrinth/<官方 path>        ← api.modrinth.com / cdn.modrinth.com
// 用法：node scripts/sync-loaders.mjs [MC版本，默认 1.21.1] [--mirror <镜像根，默认 ~/1b1t-mirror>]
// 同步范围：fabric/quilt meta（全量列表+最新5个版本）、4 加载器最新版的全部依赖库、fabric-api/qfapi
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const { httpDownload } = require2('../dist-electron/http.js');
const { extractZip } = require2('../dist-electron/zip.js');

const MC = process.argv.slice(2).find((a) => !a.startsWith('--')) || '1.21.1';
const MIRROR = (() => {
  const i = process.argv.indexOf('--mirror');
  return i >= 0 ? process.argv[i + 1] : path.join(os.homedir(), '1b1t-mirror');
})();

let downloaded = 0;
let reused = 0;

async function fetchTo(url, dest) {
  if (fs.existsSync(dest)) {
    if (fs.statSync(dest).size > 0) {
      reused += 1;
      return true;
    }
    // 0 字节残留（上次失败写盘）清理后重下
    try {
      fs.unlinkSync(dest);
    } catch {
      // 忽略
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await httpDownload(url, dest, { timeoutMs: 20000 });
  if (!r.ok) {
    console.error(`  ✗ ${url} (${r.error})`);
    return false;
  }
  downloaded += 1;
  return true;
}

/** 官方 URL → 镜像落盘路径（域名目录规则） */
function mirrorDest(officialUrl) {
  const u = new URL(officialUrl);
  let prefix;
  if (u.host === 'meta.fabricmc.net') prefix = 'fabric-meta';
  else if (u.host === 'meta.quiltmc.org') prefix = 'quilt-meta';
  else if (u.host === 'api.modrinth.com' || u.host === 'cdn.modrinth.com') prefix = 'modrinth';
  else if (
    u.host === 'maven.fabricmc.net' ||
    u.host === 'maven.minecraftforge.net' ||
    u.host === 'maven.neoforged.net' ||
    u.host === 'maven.quiltmc.org'
  ) {
    // 聚合 /maven/<path>：quilt 去 /repository/release 前缀，其余去 /releases 前缀（BMCLAPI 聚合规则）
    let p = u.pathname;
    p = p.replace(/^\/repository\/release/, '').replace(/^\/releases/, '');
    return path.join(MIRROR, 'maven', p.replace(/^\//, ''));
  } else return null;
  return path.join(MIRROR, prefix, u.pathname.replace(/^\//, ''));
}

async function main() {
  console.log(`[加载器同步] MC ${MC} → ${MIRROR}`);

  // 1. fabric-meta：列表 + 最新 5 个版本 meta
  console.log('[1/7] fabric-meta…');
  const fList = `https://meta.fabricmc.net/v2/versions/loader/${MC}`;
  await fetchTo(fList, path.join(MIRROR, 'fabric-meta', 'v2', 'versions', 'loader', MC, 'index.json'));
  let fMeta;
  try {
    fMeta = JSON.parse(fs.readFileSync(path.join(MIRROR, 'fabric-meta', 'v2', 'versions', 'loader', MC, 'index.json'), 'utf-8'));
  } catch {
    fMeta = [];
  }
  for (const e of fMeta.slice(0, 5)) {
    if (e?.loader?.version) {
      await fetchTo(
        `https://meta.fabricmc.net/v2/versions/loader/${MC}/${e.loader.version}`,
        path.join(MIRROR, 'fabric-meta', 'v2', 'versions', 'loader', MC, e.loader.version),
      );
    }
  }

  // 2. quilt-meta：列表 + 最新 5 个
  console.log('[2/7] quilt-meta…');
  const qList = `https://meta.quiltmc.org/v3/versions/loader/${MC}`;
  await fetchTo(qList, path.join(MIRROR, 'quilt-meta', 'v3', 'versions', 'loader', MC, 'index.json'));
  let qMeta;
  try {
    qMeta = JSON.parse(fs.readFileSync(path.join(MIRROR, 'quilt-meta', 'v3', 'versions', 'loader', MC, 'index.json'), 'utf-8'));
  } catch {
    qMeta = [];
  }
  for (const e of qMeta.slice(0, 5)) {
    if (e?.loader?.version) {
      await fetchTo(
        `https://meta.quiltmc.org/v3/versions/loader/${MC}/${e.loader.version}`,
        path.join(MIRROR, 'quilt-meta', 'v3', 'versions', 'loader', MC, e.loader.version),
      );
    }
  }

  // 3. fabric 最新 loader 依赖库
  console.log('[3/7] fabric maven 依赖…');
  const fabricLatest = fMeta[0];
  if (fabricLatest?.loader?.version) {
    const metaPath = path.join(MIRROR, 'fabric-meta', 'v2', 'versions', 'loader', MC, fabricLatest.loader.version);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const items = [
      { coord: meta.intermediary?.maven, url: 'https://maven.fabricmc.net' },
      { coord: meta.loader?.maven, url: 'https://maven.fabricmc.net' },
    ];
    const lmLibs = meta.launcherMeta?.libraries;
    const lmList = Array.isArray(lmLibs) ? lmLibs : [...(lmLibs?.common ?? []), ...(lmLibs?.client ?? [])];
    for (const l of lmList) if (l?.name) items.push({ coord: l.name, url: l.url ?? 'https://maven.fabricmc.net' });
    await syncMaven(items, 'https://maven.fabricmc.net');
  }

  // 4. quilt 最新 loader 依赖库
  console.log('[4/7] quilt maven 依赖…');
  const quiltLatest = qMeta[0];
  if (quiltLatest?.loader?.version) {
    const metaPath = path.join(MIRROR, 'quilt-meta', 'v3', 'versions', 'loader', MC, quiltLatest.loader.version);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const items = [];
    const lmLibs = meta.launcherMeta?.libraries;
    const lmList = Array.isArray(lmLibs) ? lmLibs : [...(lmLibs?.common ?? []), ...(lmLibs?.client ?? [])];
    for (const l of lmList) if (l?.name) items.push({ coord: l.name, url: l.url ?? 'https://maven.quiltmc.org/repository/release' });
    await syncMaven(items, 'https://maven.quiltmc.org/repository/release');
  }

  // 5. forge 最新 installer + versionInfo 依赖
  console.log('[5/7] forge…');
  await syncForgeLike('forge', `https://maven.minecraftforge.net/net/minecraftforge/forge`, MC);

  // 6. neoforge 最新 installer + versionInfo 依赖
  console.log('[6/7] neoforge…');
  await syncForgeLike('neoforge', `https://maven.neoforged.net/releases/net/neoforged/neoforge`, MC);

  // 7. Modrinth API mod
  console.log('[7/7] API mod（fabric-api / qfapi）…');
  for (const [slug, loader] of [
    ['fabric-api', 'fabric'],
    ['qfapi', 'quilt'],
  ]) {
    const apiUrl = `https://api.modrinth.com/v2/project/${slug}/version?game_versions=${encodeURIComponent(JSON.stringify([MC]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
    const tmp = path.join(os.tmpdir(), `mcore-api-${slug}-${Date.now()}.json`);
    const r = await httpDownload(apiUrl, tmp, { timeoutMs: 20000 });
    if (r.ok) {
      const arr = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
      for (const v of arr) {
        const primary = v.files?.find((f) => f.primary) ?? v.files?.[0];
        if (primary?.url) {
          // 元数据 json 落盘（供离线查询）+ jar 落盘
          const destJson = mirrorDest(apiUrl);
          if (destJson) {
            fs.mkdirSync(path.dirname(destJson), { recursive: true });
            fs.copyFileSync(tmp, destJson);
          }
          await fetchTo(primary.url, mirrorDest(primary.url));
          break;
        }
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }

  console.log(`[完成] 下载 ${downloaded}，复用 ${reused}`);
  console.log('下一步：python3 scripts/upload-s3.py 将增量同步到 mcdown 存储桶');
}

/** maven 坐标（带条目自带仓库 url）→ 官方 URL → 镜像 /maven 聚合 */
async function syncMaven(items, mavenBase) {
  for (const it of items.filter((x) => x?.coord)) {
    const [group, artifact, version, classifier] = it.coord.split(':');
    if (!group || !artifact || !version) continue;
    const rel = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
    const base = (it.url || mavenBase).replace(/\/$/, '');
    await fetchTo(`${base}/${rel}`, path.join(MIRROR, 'maven', rel));
  }
}

/** forge/neoforge：最新版本 installer → 解压 install_profile → versionInfo 依赖同步 */
async function syncForgeLike(kind, mavenBase, mc) {
  const metaUrl = `${mavenBase}/maven-metadata.xml`;
  const tmpMeta = path.join(os.tmpdir(), `mcore-sf-${kind}-${Date.now()}.xml`);
  const r = await httpDownload(metaUrl, tmpMeta, { timeoutMs: 20000 });
  if (!r.ok) {
    console.error(`  ✗ ${kind} metadata 拉取失败`);
    return;
  }
  const xml = fs.readFileSync(tmpMeta, 'utf-8');
  const versions = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), (m) => m[1]);
  // forge: <mc>-<loaderVer>；neoforge: <mcMajor>.<mcMinor>.<patch>
  let filtered;
  if (kind === 'forge') filtered = versions.filter((v) => v.startsWith(`${mc}-`));
  else {
    const m = mc.match(/^\d+\.(\d+)\.(\d+)/);
    const prefix = m ? `${m[1]}.${m[2]}.` : '';
    filtered = versions.filter((v) => v.startsWith(prefix));
  }
  if (filtered.length === 0) {
    console.error(`  ✗ ${kind} 无匹配版本`);
    return;
  }
  const latest = filtered[filtered.length - 1];
  console.log(`  ${kind} 最新: ${latest}`);

  // installer 下载（临时）
  const installRel = `${kind === 'neoforge' ? '' : ''}`;
  const g = kind === 'forge' ? 'net/minecraftforge/forge' : 'net/neoforged/neoforge';
  const jarName = `${kind === 'forge' ? `forge-${latest}` : `neoforge-${latest}`}-installer.jar`;
  const instUrl = `${mavenBase}/${latest}/${jarName}`;
  const tmpJar = path.join(os.tmpdir(), `mcore-sf-${kind}-${Date.now()}.jar`);
  const rr = await httpDownload(instUrl, tmpJar, { timeoutMs: 30000 });
  if (!rr.ok) {
    console.error(`  ✗ installer 下载失败: ${instUrl}`);
    return;
  }
  // installer 本体也同步到镜像 /maven 聚合
  const instRel = `${g}/${latest}/${jarName}`;
  fs.mkdirSync(path.dirname(path.join(MIRROR, 'maven', instRel)), { recursive: true });
  fs.copyFileSync(tmpJar, path.join(MIRROR, 'maven', instRel));

  // 解压 install_profile
  const xdir = path.join(os.tmpdir(), `mcore-sfx-${kind}-${Date.now()}`);
  fs.mkdirSync(xdir, { recursive: true });
  extractZip(tmpJar, xdir, []);
  const profilePath = path.join(xdir, 'install_profile.json');
  if (!fs.existsSync(profilePath)) {
    console.error(`  ✗ install_profile 缺失`);
    return;
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  const vi = profile.versionInfo ?? {};
  const libs = [];
  for (const lib of vi.libraries ?? []) {
    const url = lib.downloads?.artifact?.url ?? '';
    if (url.includes('minecraftforge.net') || url.includes('neoforged.net')) {
      // 加载器域库 → /maven 聚合（rel path 用官方 maven path）
      const u = new URL(url);
      let p = u.pathname;
      p = p.replace(/^\/releases/, '');
      libs.push({ url: `${kind === 'forge' ? 'https://maven.minecraftforge.net' : 'https://maven.neoforged.net/releases'}${p.replace(/^\/releases/, '')}`, dest: path.join(MIRROR, 'maven', p.replace(/^\//, '')) });
    }
  }
  for (const l of libs) {
    await fetchTo(l.url, l.dest);
  }
  fs.rmSync(xdir, { recursive: true, force: true });
  try {
    fs.unlinkSync(tmpJar);
  } catch {
    // 忽略
  }
  try {
    fs.unlinkSync(tmpMeta);
  } catch {
    // 忽略
  }
}

main().catch((e) => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
