// Fabric / Quilt 全量资源同步到私有镜像（覆盖全部 MC 版本，不限于单个版本）
// 同步范围：
//   fabric-meta / quilt-meta：全部支持 MC 版本的列表 + 每个 MC 版本最新 3 个 loader 版本 meta
//   fabric-loader / quilt-loader：全部 loader 版本 jar
//   intermediary（fabric）/ hashed（quilt）：全部 MC 版本的映射 jar
//   依赖库：从各 meta 提取的全部 maven 库（去重）
//   Modrinth fabric-api / qfapi：全部版本文件
// 落盘规则与启动器一致：<镜像>/fabric-meta/...、<镜像>/quilt-meta/...、<镜像>/maven/<path>、<镜像>/modrinth/<path>
// 用法：node scripts/sync-loaders-all.mjs [--mirror <路径>]
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const { httpDownload } = require2('../dist-electron/http.js');

const MIRROR = (() => {
  const i = process.argv.indexOf('--mirror');
  return i >= 0 ? process.argv[i + 1] : path.join(os.homedir(), '1b1t-mirror');
})();

let downloaded = 0;
let reused = 0;
let failed = 0;

async function fetchTo(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    reused += 1;
    return true;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await httpDownload(url, dest, { timeoutMs: 30000 });
    if (!r.ok) {
      failed += 1;
      return false;
    }
    downloaded += 1;
    return true;
  } catch (e) {
    // 目标路径曾是文件的情况：删除后重试一次
    try {
      fs.unlinkSync(dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const r = await httpDownload(url, dest, { timeoutMs: 30000 });
      if (r.ok) {
        downloaded += 1;
        return true;
      }
    } catch {
      // 忽略
    }
    failed += 1;
    return false;
  }
}

async function getJson(url) {
  const tmp = path.join(os.tmpdir(), `mcore-sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    const r = await httpDownload(url, tmp, { timeoutMs: 30000 });
    if (!r.ok) return null;
    return JSON.parse(fs.readFileSync(tmp, 'utf-8'));
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

function mavenRel(coord) {
  const [group, artifact, version, classifier] = coord.split(':');
  if (!group || !artifact || !version) return '';
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
}

/** 从 loader meta 提取 maven 库清单（含条目自带 url） */
function extractMavenItems(meta, kind) {
  const items = [];
  const push = (coord, url) => {
    if (coord) items.push({ coord, url: url || (kind === 'fabric' ? 'https://maven.fabricmc.net' : 'https://maven.quiltmc.org/repository/release') });
  };
  push(meta?.intermediary?.maven, kind === 'fabric' ? 'https://maven.fabricmc.net' : undefined);
  push(meta?.hashed?.maven, 'https://maven.quiltmc.org/repository/release');
  push(meta?.loader?.maven, kind === 'fabric' ? 'https://maven.fabricmc.net' : 'https://maven.quiltmc.org/repository/release');
  const lmLibs = meta?.launcherMeta?.libraries;
  const lmList = Array.isArray(lmLibs) ? lmLibs : [...(lmLibs?.common ?? []), ...(lmLibs?.client ?? [])];
  for (const l of lmList) push(l?.name, l?.url);
  return items;
}

async function main() {
  console.log(`[全量同步] Fabric/Quilt → ${MIRROR}`);
  const start = Date.now();

  // ---- 1. fabric ----
  console.log('[1] fabric-meta：全部 MC 版本列表…');
  const fAll = await getJson('https://meta.fabricmc.net/v2/versions');
  const fabricMcVersions = ((fAll ?? {}).game ?? []).map((e) => e.version).filter(Boolean);
  console.log(`  fabric 支持 ${fabricMcVersions.length} 个 MC 版本`);

  const mavenQueue = new Map(); // rel -> url（去重）

  const fPool = [];
  let fDone = 0;
  for (let w = 0; w < 8; w += 1) {
    fPool.push(
      (async () => {
        for (let i = w; i < fabricMcVersions.length; i += 8) {
          const mc = fabricMcVersions[i];
          await fetchTo(
            `https://meta.fabricmc.net/v2/versions/loader/${mc}`,
            path.join(MIRROR, 'fabric-meta', 'v2', 'versions', 'loader', mc, 'index.json'),
          );
          const list = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mc}`);
          for (const e of (list ?? []).slice(0, 3)) {
            if (!e?.loader?.version) continue;
            const ok = await fetchTo(
              `https://meta.fabricmc.net/v2/versions/loader/${mc}/${e.loader.version}`,
              path.join(MIRROR, 'fabric-meta', 'v2', 'versions', 'loader', mc, e.loader.version),
            );
            if (!ok) continue;
            const meta = JSON.parse(
              fs.readFileSync(path.join(MIRROR, 'fabric-meta', 'v2', 'versions', 'loader', mc, e.loader.version), 'utf-8'),
            );
            for (const it of extractMavenItems(meta, 'fabric')) {
              const rel = mavenRel(it.coord);
              if (rel && !mavenQueue.has(rel)) mavenQueue.set(rel, it.url);
            }
          }
          fDone += 1;
          if (fDone % 50 === 0) console.log(`  [fabric] ${fDone}/${fabricMcVersions.length}`);
        }
      })(),
    );
  }
  await Promise.all(fPool);

  // ---- 2. fabric-loader 全部版本 jar ----
  console.log('[2] fabric-loader 全部版本…');
  const fLoaders = await getJson('https://meta.fabricmc.net/v2/versions/loader');
  for (const e of fLoaders ?? []) {
    if (e?.loader?.version) {
      mavenQueue.set(
        mavenRel(`net.fabricmc:fabric-loader:${e.loader.version}`),
        'https://maven.fabricmc.net',
      );
    }
  }
  console.log(`  loader 版本 ${fLoaders?.length ?? 0} 个`);

  // ---- 3. quilt ----
  console.log('[3] quilt-meta：全部 MC 版本列表…');
  const qAll = await getJson('https://meta.quiltmc.org/v3/versions');
  const quiltMcVersions = ((qAll ?? {}).game ?? []).map((e) => e.version).filter(Boolean);
  console.log(`  quilt 支持 ${quiltMcVersions.length} 个 MC 版本`);

  const qPool = [];
  let qDone = 0;
  for (let w = 0; w < 8; w += 1) {
    qPool.push(
      (async () => {
        for (let i = w; i < quiltMcVersions.length; i += 8) {
          const mc = quiltMcVersions[i];
          await fetchTo(
            `https://meta.quiltmc.org/v3/versions/loader/${mc}`,
            path.join(MIRROR, 'quilt-meta', 'v3', 'versions', 'loader', mc, 'index.json'),
          );
          const list = await getJson(`https://meta.quiltmc.org/v3/versions/loader/${mc}`);
          for (const e of (list ?? []).slice(0, 3)) {
            if (!e?.loader?.version) continue;
            const ok = await fetchTo(
              `https://meta.quiltmc.org/v3/versions/loader/${mc}/${e.loader.version}`,
              path.join(MIRROR, 'quilt-meta', 'v3', 'versions', 'loader', mc, e.loader.version),
            );
            if (!ok) continue;
            const meta = JSON.parse(
              fs.readFileSync(path.join(MIRROR, 'quilt-meta', 'v3', 'versions', 'loader', mc, e.loader.version), 'utf-8'),
            );
            for (const it of extractMavenItems(meta, 'quilt')) {
              const rel = mavenRel(it.coord);
              if (rel && !mavenQueue.has(rel)) mavenQueue.set(rel, it.url);
            }
          }
          qDone += 1;
          if (qDone % 50 === 0) console.log(`  [quilt] ${qDone}/${quiltMcVersions.length}`);
        }
      })(),
    );
  }
  await Promise.all(qPool);

  // ---- 4. quilt-loader 全部版本 jar ----
  console.log('[4] quilt-loader 全部版本…');
  const qLoaders = await getJson('https://meta.quiltmc.org/v3/versions/loader');
  for (const e of qLoaders ?? []) {
    if (e?.loader?.version) {
      mavenQueue.set(
        mavenRel(`org.quiltmc:quilt-loader:${e.loader.version}`),
        'https://maven.quiltmc.org/repository/release',
      );
    }
  }
  console.log(`  loader 版本 ${qLoaders?.length ?? 0} 个`);

  // ---- 5. maven 库批量下载（8 并发）----
  console.log(`[5] maven 库 ${mavenQueue.size} 个…`);
  const entries = Array.from(mavenQueue.entries());
  const pool = [];
  let mDone = 0;
  for (let w = 0; w < 16; w += 1) {
    pool.push(
      (async () => {
        for (let i = w; i < entries.length; i += 16) {
          const [rel, url] = entries[i];
          await fetchTo(`${(url || '').replace(/\/$/, '')}/${rel}`, path.join(MIRROR, 'maven', rel));
          mDone += 1;
          if (mDone % 100 === 0) console.log(`  [maven] ${mDone}/${entries.length}`);
        }
      })(),
    );
  }
  await Promise.all(pool);

  // ---- 6. Modrinth API 全部版本 ----
  console.log('[6] Modrinth API mod 全部版本…');
  for (const slug of ['fabric-api', 'qfapi']) {
    const versions = await getJson(`https://api.modrinth.com/v2/project/${slug}/version`);
    for (const v of versions ?? []) {
      const primary = v.files?.find((f) => f.primary) ?? v.files?.[0];
      if (!primary?.url) continue;
      const u = new URL(primary.url);
      await fetchTo(primary.url, path.join(MIRROR, 'modrinth', u.pathname.replace(/^\//, '')));
    }
    console.log(`  ${slug}: ${versions?.length ?? 0} 个版本`);
  }

  const mins = Math.round((Date.now() - start) / 60000);
  console.log(`[完成] 下载 ${downloaded}，复用 ${reused}，失败 ${failed}，耗时 ${mins} 分钟`);
  console.log('下一步：python3 scripts/upload-s3.py 增量传桶');
}

main().catch((e) => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
