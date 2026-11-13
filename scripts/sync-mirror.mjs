// 客户端资源同步到 1B1T mirror（独立工具，与启动器解耦）
// 目录约定（与 MANUAL.md 4.1 一致）：
//   <mirror>/mc/game/version_manifest_v2.json
//   <mirror>/version/<id>/json | client
//   <mirror>/libraries/<path>          （全平台）
//   <mirror>/v1/packages/<hash>/<name>.json
//   <mirror>/assets/<h2>/<hash>
// 用法：node scripts/sync-mirror.mjs <版本> [--mirror <镜像根，默认 ~/1b1t-mirror/bmclapi2.bangbang93.com>] [--dry-run]
// 优先复用本机 ~/.minecraft 已有文件，缺失的从 BMCLAPI 拉取
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const { httpDownload } = require2('../dist-electron/http.js');
const { sha1File } = require2('../dist-electron/downloader.js');

const BMCL = 'https://bmclapi2.bangbang93.com';
const GAME_DIR = path.join(os.homedir(), '.minecraft');
const MIRROR_ROOT = path.join(os.homedir(), '1b1t-mirror', 'bmclapi2.bangbang93.com');

const args = process.argv.slice(2);
const versionId = args.find((a) => !a.startsWith('--'));
const mirrorRoot = (() => {
  const i = args.indexOf('--mirror');
  return i >= 0 ? args[i + 1] : MIRROR_ROOT;
})();
const dryRun = args.includes('--dry-run');

if (!versionId) {
  console.log('用法: node scripts/sync-mirror.mjs <版本id> [--mirror <路径>] [--dry-run]');
  process.exit(1);
}

let downloaded = 0;
let reused = 0;
let skipped = 0;

function ensureDir(p) {
  if (!dryRun) fs.mkdirSync(path.dirname(p), { recursive: true });
}

/** 已有且大小匹配则跳过，否则下载 */
async function fetchTo(url, dest, expectedSize = 0) {
  ensureDir(dest);
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (expectedSize === 0 || st.size === expectedSize) {
      reused += 1;
      return true;
    }
  }
  if (dryRun) {
    console.log(`  [dry-run] ${url} -> ${dest.replace(mirrorRoot, '<mirror>')}`);
    skipped += 1;
    return true;
  }
  const r = await httpDownload(url, dest, { expectedSize, timeoutMs: 15000 });
  if (!r.ok) {
    console.error(`  下载失败: ${url} (${r.error})`);
    return false;
  }
  downloaded += 1;
  return true;
}

/** 本机已有则直接复制到镜像，否则从 BMCLAPI 下载 */
async function localOrDownload(relUrl, localPath, mirrorRelPath, expectedSize = 0) {
  const dest = path.join(mirrorRoot, mirrorRelPath);
  ensureDir(dest);
  if (fs.existsSync(dest) && (expectedSize === 0 || fs.statSync(dest).size === expectedSize)) {
    reused += 1;
    return true;
  }
  if (fs.existsSync(localPath)) {
    if (dryRun) {
      console.log(`  [dry-run] 复制 ${localPath} -> ${mirrorRelPath}`);
    } else {
      fs.copyFileSync(localPath, dest);
    }
    reused += 1;
    return true;
  }
  return fetchTo(`${BMCL}${relUrl}`, dest, expectedSize);
}

async function main() {
  console.log(`[同步] 版本 ${versionId} → ${mirrorRoot}${dryRun ? '（dry-run）' : ''}`);

  // 1. 版本清单（全量）
  console.log('[1/5] 版本清单…');
  await fetchTo(`${BMCL}/mc/game/version_manifest_v2.json`, path.join(mirrorRoot, 'mc/game/version_manifest_v2.json'));

  // 2. version json
  console.log('[2/5] 版本描述 json…');
  const localJson = path.join(GAME_DIR, 'versions', versionId, `${versionId}.json`);
  if (!(await localOrDownload(`/version/${versionId}/json`, localJson, `version/${versionId}/json`))) return;

  const version = JSON.parse(fs.readFileSync(localJson, 'utf-8'));
  const clientSha1 = version.downloads?.client?.sha1 ?? '';

  // 3. client jar
  console.log('[3/5] 客户端核心 jar…');
  const localJar = path.join(GAME_DIR, 'versions', versionId, `${versionId}.jar`);
  if (!(await localOrDownload(`/version/${versionId}/client`, localJar, `version/${versionId}/client`))) return;
  if (!dryRun) {
    const h = await sha1File(path.join(mirrorRoot, `version/${versionId}/client`));
    if (h !== clientSha1) {
      console.error(`  client.jar SHA1 不符: ${h} != ${clientSha1}`);
      return;
    }
  }

  // 4. libraries（全平台 artifact + 全部分类器）
  console.log('[4/5] 依赖库（全平台）…');
  const libs = [];
  for (const lib of version.libraries ?? []) {
    const art = lib.downloads?.artifact;
    if (art?.path) libs.push({ rel: art.path, size: art.size ?? 0, sha1: art.sha1 ?? '' });
    for (const cls of Object.values(lib.downloads?.classifiers ?? {})) {
      if (cls?.path) libs.push({ rel: cls.path, size: cls.size ?? 0, sha1: cls.sha1 ?? '' });
    }
  }
  // 8 并发
  const pool = [];
  for (let i = 0; i < Math.min(8, libs.length); i += 1) {
    pool.push((async () => {
      for (let j = i; j < libs.length; j += 8) {
        const lib = libs[j];
        await localOrDownload(`/libraries/${lib.rel}`, path.join(GAME_DIR, 'libraries', lib.rel), `libraries/${lib.rel}`, lib.size);
      }
    })());
  }
  await Promise.all(pool);

  // 5. assetIndex + assets objects
  console.log('[5/5] 资产索引与资产文件…');
  const ai = version.assetIndex;
  const aiRel = ai?.url ? new URL(ai.url).pathname : '';
  const localAi = path.join(GAME_DIR, 'assets', 'indexes', `${ai?.id}.json`);
  if (aiRel) {
    if (!(await localOrDownload(aiRel, localAi, aiRel.slice(1)))) return;
  }
  const aiPath = path.join(mirrorRoot, aiRel.slice(1));
  const objects = JSON.parse(fs.readFileSync(localAi, 'utf-8')).objects ?? {};
  const entries = Object.values(objects);
  console.log(`  资产文件 ${entries.length} 个`);
  const pool2 = [];
  for (let i = 0; i < Math.min(8, entries.length); i += 1) {
    pool2.push((async () => {
      for (let j = i; j < entries.length; j += 8) {
        const o = entries[j];
        const h2 = o.hash.slice(0, 2);
        await localOrDownload(
          `/assets/${h2}/${o.hash}`,
          path.join(GAME_DIR, 'assets', 'objects', h2, o.hash),
          `assets/${h2}/${o.hash}`,
          o.size ?? 0,
        );
      }
    })());
  }
  await Promise.all(pool2);

  console.log(`[完成] 复用 ${reused}，下载 ${downloaded}${dryRun ? `，待复制 ${skipped}` : ''}`);
}

main().catch((e) => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
