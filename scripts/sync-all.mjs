// 全版本客户端资源同步到 1B1T mirror（从远古到最新，逐版本）
// 用法：node scripts/sync-all.mjs [--limit N] [--mirror <路径>]
// 支持中断续跑：已完整同步的版本自动跳过；失败清单写 ~/1b1t-mirror/sync-failures.json
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
const FAILURES_FILE = path.join(os.homedir(), '1b1t-mirror', 'sync-failures.json');

const args = process.argv.slice(2);
const limit = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();
const mirrorRoot = (() => {
  const i = args.indexOf('--mirror');
  return i >= 0 ? args[i + 1] : MIRROR_ROOT;
})();

// ---- 下载工具（3 次重试 + 请求间隔防频控）----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTo(url, dest, expectedSize = 0) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (expectedSize === 0 || st.size === expectedSize) return { ok: true, skipped: true };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await httpDownload(url, dest, { expectedSize, timeoutMs: 20000 });
    if (r.ok) return { ok: true, skipped: false };
    if (r.status === 404) return { ok: false, error: 'HTTP 404（源无此文件）' };
    await sleep(300 + Math.random() * 400);
  }
  return { ok: false, error: '重试 3 次仍失败' };
}

/** 本机已有则复制到镜像，否则从 BMCLAPI 下载 */
async function localOrDownload(relUrl, localPath, mirrorRelPath, expectedSize = 0) {
  const dest = path.join(mirrorRoot, mirrorRelPath);
  if (fs.existsSync(dest) && (expectedSize === 0 || fs.statSync(dest).size === expectedSize)) {
    return { ok: true, skipped: true };
  }
  if (fs.existsSync(localPath)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(localPath, dest);
      return { ok: true, skipped: true };
    } catch {
      // 复制失败走下载
    }
  }
  return fetchTo(`${BMCL}${relUrl}`, dest, expectedSize);
}

/** 老版本 library 无 downloads 字段时按 name 拼路径 */
function libraryPathFromName(name) {
  const [group, artifact, version] = String(name).split(':');
  if (!group || !artifact || !version) return '';
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
}

// ---- 单版本同步 ----
async function syncVersion(versionId, stats) {
  // 断点续跑：json + client 已存在即跳过
  const mJson = path.join(mirrorRoot, 'version', versionId, 'json');
  const mClient = path.join(mirrorRoot, 'version', versionId, 'client');
  if (fs.existsSync(mJson) && fs.existsSync(mClient)) {
    stats.skipped += 1;
    return;
  }

  // 1. version json（下载到镜像；解析读镜像路径——本机可能没有该文件）
  const localJson = path.join(GAME_DIR, 'versions', versionId, `${versionId}.json`);
  const mirrorJsonPath = path.join(mirrorRoot, 'version', versionId, 'json');
  const jr = await localOrDownload(`/version/${versionId}/json`, localJson, `version/${versionId}/json`);
  if (!jr.ok) {
    stats.failed.push({ id: versionId, reason: `version json: ${jr.error}` });
    return;
  }

  let version;
  try {
    version = JSON.parse(fs.readFileSync(mirrorJsonPath, 'utf-8'));
  } catch {
    stats.failed.push({ id: versionId, reason: 'version json 解析失败' });
    return;
  }

  // 2. client jar（无 downloads.client 的版本跳过核心）
  const client = version.downloads?.client;
  if (!client) {
    stats.failed.push({ id: versionId, reason: '无客户端核心（downloads.client 缺失）' });
    return;
  }
  const localJar = path.join(GAME_DIR, 'versions', versionId, `${versionId}.jar`);
  const cr = await localOrDownload(`/version/${versionId}/client`, localJar, `version/${versionId}/client`, client.size ?? 0);
  if (!cr.ok) {
    stats.failed.push({ id: versionId, reason: `client jar: ${cr.error}` });
    return;
  }
  if (client.sha1) {
    const h = await sha1File(path.join(mirrorRoot, `version/${versionId}/client`));
    if (h !== client.sha1) {
      fs.rmSync(path.join(mirrorRoot, `version/${versionId}/client`), { force: true });
      stats.failed.push({ id: versionId, reason: 'client jar SHA1 校验失败' });
      return;
    }
  }

  // 3. libraries（全平台 artifact + classifiers；老版本按 name 拼路径）
  const libs = [];
  for (const lib of version.libraries ?? []) {
    const art = lib.downloads?.artifact;
    if (art?.path) {
      libs.push({ rel: art.path, size: art.size ?? 0 });
    } else if (lib.name) {
      const rel = libraryPathFromName(lib.name);
      if (rel) libs.push({ rel, size: 0 });
    }
    for (const cls of Object.values(lib.downloads?.classifiers ?? {})) {
      if (cls?.path) libs.push({ rel: cls.path, size: cls.size ?? 0 });
    }
  }
  const pool = [];
  for (let i = 0; i < Math.min(8, libs.length); i += 1) {
    pool.push(
      (async () => {
        for (let j = i; j < libs.length; j += 8) {
          const lib = libs[j];
          await localOrDownload(`/libraries/${lib.rel}`, path.join(GAME_DIR, 'libraries', lib.rel), `libraries/${lib.rel}`, lib.size);
          await sleep(30 + Math.random() * 80);
        }
      })(),
    );
  }
  await Promise.all(pool);

  // 4. assetIndex + assets objects（legacy 结构无 objects → 跳过资产）
  const ai = version.assetIndex;
  if (ai) {
    let aiRel = '';
    try {
      aiRel = ai.url ? new URL(ai.url).pathname : '';
    } catch {
      aiRel = '';
    }
    const localAi = path.join(GAME_DIR, 'assets', 'indexes', `${ai.id}.json`);
    const mirrorAiPath = aiRel ? path.join(mirrorRoot, aiRel.slice(1)) : '';
    if (aiRel) {
      await localOrDownload(aiRel, localAi, aiRel.slice(1), ai.size ?? 0);
    }
    let objects;
    try {
      objects = JSON.parse(fs.readFileSync(mirrorAiPath || localAi, 'utf-8')).objects;
    } catch {
      objects = undefined;
    }
    if (objects) {
      const entries = Object.values(objects);
      const pool2 = [];
      for (let i = 0; i < Math.min(8, entries.length); i += 1) {
        pool2.push(
          (async () => {
            for (let j = i; j < entries.length; j += 8) {
              const o = entries[j];
              if (!o?.hash) continue;
              const h2 = o.hash.slice(0, 2);
              await localOrDownload(
                `/assets/${h2}/${o.hash}`,
                path.join(GAME_DIR, 'assets', 'objects', h2, o.hash),
                `assets/${h2}/${o.hash}`,
                o.size ?? 0,
              );
              await sleep(10 + Math.random() * 40);
            }
          })(),
        );
      }
      await Promise.all(pool2);
    }
  }

  stats.done += 1;
}

// ---- 主流程 ----
async function main() {
  const failures = fs.existsSync(FAILURES_FILE) ? JSON.parse(fs.readFileSync(FAILURES_FILE, 'utf-8')) : [];
  const baseFailed = failures.length;
  const stats = { done: 0, skipped: 0, failed: failures };

  // 全量清单
  const manifestRaw = await fetchTo(
    `${BMCL}/mc/game/version_manifest_v2.json`,
    path.join(mirrorRoot, 'mc/game/version_manifest_v2.json'),
  );
  if (!manifestRaw.ok) {
    console.error('manifest 拉取失败:', manifestRaw.error);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(mirrorRoot, 'mc/game/version_manifest_v2.json'), 'utf-8'));
  const versions = manifest.versions ?? [];
  const todo = versions.slice(0, Math.min(limit, versions.length));

  console.log(`[sync-all] 共 ${versions.length} 个版本${limit !== Infinity ? `，本次处理前 ${limit} 个` : ''}`);
  const t0 = Date.now();

  for (let idx = 0; idx < todo.length; idx += 1) {
    const v = todo[idx];
    const before = stats.done + stats.skipped + stats.failed.length;
    await syncVersion(v.id, stats);
    const after = stats.done + stats.skipped + stats.failed.length;
    if (after > before) {
      console.log(`[${idx + 1}/${todo.length}] ${v.id} ${v.type}`);
    }
    if ((idx + 1) % 50 === 0) {
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(
        `--- 汇总 ${idx + 1}/${todo.length}：完成 ${stats.done}，跳过 ${stats.skipped}，失败 ${stats.failed.length - baseFailed}（本次），耗时 ${Math.floor(secs / 60)}m${secs % 60}s ---`,
      );
      fs.writeFileSync(FAILURES_FILE, JSON.stringify(stats.failed, null, 2));
    }
    await sleep(150 + Math.random() * 250);
  }

  fs.writeFileSync(FAILURES_FILE, JSON.stringify(stats.failed, null, 2));
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[完成] 完成 ${stats.done}，跳过（已存在）${stats.skipped}，失败 ${stats.failed.length - baseFailed}，总耗时 ${Math.floor(secs / 60)}m${secs % 60}s`,
  );
}

main().catch((e) => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
