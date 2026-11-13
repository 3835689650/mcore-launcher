// MCore 主干逻辑自测：下载器（SHA1/断点续传/换源/慢速/全源失败）、
// 离线账号、启动参数生成、服务器索引、源链模式、zip 解压、测速
// 用法：先 npm run build，再 node scripts/unit-test.mjs
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

const PORT = 8199;
const MOCK_BASE = `http://127.0.0.1:${PORT}`;
const require2 = createRequire(import.meta.url);

// ---- 环境准备 ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-test-'));
const USERDATA = path.join(TMP, 'userdata');
const GAMEDIR = path.join(TMP, 'game');
fs.mkdirSync(USERDATA, { recursive: true });
fs.mkdirSync(GAMEDIR, { recursive: true });

// stub electron（主进程模块在 node 环境加载）
import Module from 'node:module';
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: (name) => (name === 'userData' ? USERDATA : os.homedir()),
        isPackaged: false,
      },
    };
  }
  return origLoad.apply(this, arguments);
};

// 默认 mirrors 指向 mock
const mockMirrors = {
  clientSources: [
    { id: 'mock1', name: 'Mock 源1', type: 'client', protocol: 'bmclapi', baseUrl: `${MOCK_BASE}/serverdown/bmclapi2.bangbang93.com`, priority: 1, enabled: true },
    { id: 'mock2', name: 'Mock 源2', type: 'client', protocol: 'bmclapi', baseUrl: `${MOCK_BASE}/mirror2`, priority: 2, enabled: true },
  ],
  serverSource: { id: 'mock-server', name: 'Mock 服务器源', type: 'server', protocol: 'bmclapi', baseUrl: `${MOCK_BASE}/serverdown`, priority: 1, enabled: true },
};
fs.writeFileSync(path.join(USERDATA, 'mirrors.json'), JSON.stringify(mockMirrors, null, 2));

const downloader = require2('../dist-electron/downloader.js');
const httpMod = require2('../dist-electron/http.js');
const launcher = require2('../dist-electron/launcher.js');
const serversMod = require2('../dist-electron/servers.js');
const speedtest = require2('../dist-electron/speedtest.js');
const sourcesMod = require2('../dist-electron/sources.js');
const versionsMod = require2('../dist-electron/versions.js');
const configMod = require2('../dist-electron/config.js');
const zipMod = require2('../dist-electron/zip.js');

// 与 mock server 相同的确定性内容生成
function genContent(seed, size) {
  const buf = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const CLIENT = genContent(42, 512 * 1024);
const CLIENT_SHA1 = sha1(CLIENT);

// ---- 测试工具 ----
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function ctrl(m) {
  await fetch(`${MOCK_BASE}/__ctrl/mode?m=${m}`).catch(() => undefined);
}
async function ctrlStats() {
  const r = await fetch(`${MOCK_BASE}/__ctrl/stats`);
  return r.json();
}
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

// 构造候选
const cand = (sourceId, ver = 'mock-1.0') => ({
  sourceId,
  url: `${MOCK_BASE}/serverdown/bmclapi2.bangbang93.com/version/${ver}/client`,
});
const cand2 = (ver = 'mock-0.9') => ({
  sourceId: 'mock2',
  url: `${MOCK_BASE}/serverdown/bmclapi2.bangbang93.com/version/${ver}/client`,
});

// ---- 启动 mock server ----
console.log('[自测] 启动 mock server…');
const mockProc = spawn('node', [path.resolve(import.meta.dirname, '../mock-server/index.mjs'), String(PORT)], {
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 600));

// ---- 测试用例 ----
await test('T1 离线 UUID：格式/确定性/版本位', async () => {
  const u = launcher.offlineUuid('TestPlayer');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u), `格式不符: ${u}`);
  assert(launcher.offlineUuid('TestPlayer') === u, '同一用户名 UUID 不一致');
  assert(launcher.offlineUuid('Other') !== u, '不同用户名 UUID 相同');
});

await test('T2 离线用户名校验', async () => {
  assert(launcher.validateOfflineUsername('Steve') === '', '合法名被拒');
  assert(launcher.validateOfflineUsername('a_b1') === '', '下划线数字名被拒');
  assert(launcher.validateOfflineUsername('ab') !== '', '过短未拦截');
  assert(launcher.validateOfflineUsername('a'.repeat(17)) !== '', '过长未拦截');
  assert(launcher.validateOfflineUsername('中文名') !== '', '非法字符未拦截');
  assert(launcher.validateOfflineUsername('bad name') !== '', '空格未拦截');
});

await test('T3 SHA1 计算', async () => {
  const f = path.join(TMP, 'hash.bin');
  fs.writeFileSync(f, CLIENT);
  assert((await downloader.sha1File(f)) === CLIENT_SHA1, 'SHA1 计算错误');
});

await test('T4 正常下载+SHA1 校验', async () => {
  await ctrl('ok');
  const target = path.join(GAMEDIR, 't4.jar');
  rmrf(target);
  rmrf(`${target}.part`);
  const r = await downloader.runDownloads(
    [{ key: 't4', name: 't4', path: target, candidates: [cand('mock1')], sha1: CLIENT_SHA1, size: CLIENT.length }],
    { onProgress: () => undefined },
  );
  assert(r.failed.length === 0, `下载失败: ${r.failed[0]?.error}`);
  assert(fs.existsSync(target) && fs.statSync(target).size === CLIENT.length, '文件大小不符');
});

await test('T5 断点续传（.part + Range）', async () => {
  await ctrl('ok');
  const before = (await ctrlStats()).rangeRequests;
  const target = path.join(GAMEDIR, 't5.jar');
  rmrf(target);
  // 预置正确内容的前半段 .part
  fs.writeFileSync(`${target}.part`, CLIENT.subarray(0, CLIENT.length / 2));
  const r = await downloader.runDownloads(
    [{ key: 't5', name: 't5', path: target, candidates: [cand('mock1')], sha1: CLIENT_SHA1, size: CLIENT.length }],
    { onProgress: () => undefined },
  );
  assert(r.failed.length === 0, `续传失败: ${r.failed[0]?.error}`);
  assert(fs.existsSync(target) && (await downloader.sha1File(target)) === CLIENT_SHA1, '续传后 SHA1 不符');
  const after = (await ctrlStats()).rangeRequests;
  assert(after > before, '服务端未收到 Range 请求');
});

await test('T6 哈希校验失败自动换源', async () => {
  await ctrl('hash-bad');
  const target = path.join(GAMEDIR, 't6.jar');
  rmrf(target);
  rmrf(`${target}.part`);
  const r = await downloader.runDownloads(
    [{ key: 't6', name: 't6', path: target, candidates: [cand('mock1'), cand2()], sha1: CLIENT_SHA1, size: CLIENT.length }],
    { onProgress: () => undefined },
  );
  assert(r.failed.length === 0, `换源后仍失败: ${r.failed[0]?.error}`);
  assert((await downloader.sha1File(target)) === CLIENT_SHA1, '最终文件 SHA1 不符');
});

await test('T7 慢速源自动切换', async () => {
  await ctrl('slow');
  const target = path.join(GAMEDIR, 't7.jar');
  rmrf(target);
  rmrf(`${target}.part`);
  const r = await downloader.runDownloads(
    [{ key: 't7', name: 't7', path: target, candidates: [cand('mock1'), cand2()], sha1: CLIENT_SHA1, size: CLIENT.length }],
    { onProgress: () => undefined },
  );
  assert(r.failed.length === 0, `慢速换源失败: ${r.failed[0]?.error}`);
  assert((await downloader.sha1File(target)) === CLIENT_SHA1, '最终文件 SHA1 不符');
});

await test('T8 下载中断自动换源续传', async () => {
  await ctrl('interrupt');
  const target = path.join(GAMEDIR, 't8.jar');
  rmrf(target);
  rmrf(`${target}.part`);
  const r = await downloader.runDownloads(
    [{ key: 't8', name: 't8', path: target, candidates: [cand('mock1'), cand2()], sha1: CLIENT_SHA1, size: CLIENT.length }],
    { onProgress: () => undefined },
  );
  assert(r.failed.length === 0, `中断换源失败: ${r.failed[0]?.error}`);
  assert((await downloader.sha1File(target)) === CLIENT_SHA1, '最终文件 SHA1 不符');
});

await test('T9 全部源不可用 → 失败上报', async () => {
  await ctrl('offline');
  const target = path.join(GAMEDIR, 't9.jar');
  rmrf(target);
  rmrf(`${target}.part`);
  const r = await downloader.runDownloads(
    [{ key: 't9', name: 't9', path: target, candidates: [cand('mock1')], sha1: CLIENT_SHA1, size: CLIENT.length }],
    { onProgress: () => undefined },
  );
  assert(r.failed.length === 1, '应上报 1 个失败任务');
  assert(r.failed[0].status === 'failed', '状态应为 failed');
});

await test('T10 服务器索引（仅服务器源）', async () => {
  await ctrl('ok');
  const idx = await serversMod.fetchServerIndex();
  assert(Array.isArray(idx.servers) && idx.servers.length === 2, '服务器列表数量不符');
  assert(idx.coreFiles.length === 1 && idx.coreFiles[0].sha1, '核心文件条目缺失');
});

await test('T11 源测速（HEAD+manifest 实测）', async () => {
  await ctrl('ok');
  const r = await speedtest.testSource(mockMirrors.clientSources[0]);
  assert(r.ok === true, `测速未通过: ${r.error}`);
  assert(r.speedKBs > 0, '速度未测得');
});

await test('T12 源链：自动排序 / 手动锁定', async () => {
  configMod.setSettings({ sourceMode: 'auto' });
  const auto = sourcesMod.getClientSourceChain();
  assert(auto.length === 2 && auto[0].id === 'mock1', '自动模式源链错误');
  configMod.setSettings({ sourceMode: 'manual', manualSourceId: 'mock2' });
  const manual = sourcesMod.getClientSourceChain();
  assert(manual.length === 1 && manual[0].id === 'mock2', '手动模式未锁定单源');
  configMod.setSettings({ sourceMode: 'auto' });
});

await test('T13 zip 解压（natives）', async () => {
  const zipSrc = path.join(TMP, 'test.zip');
  const out = path.join(TMP, 'unzip');
  rmrf(out);
  fs.mkdirSync(out, { recursive: true });
  const { execFileSync } = await import('node:child_process');
  const srcDir = path.join(TMP, 'zipsrc');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'hello.txt'), 'hello-native');
  fs.mkdirSync(path.join(srcDir, 'META-INF'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'META-INF', 'MANIFEST.MF'), 'Manifest-Version: 1.0');
  execFileSync('python3', ['-c', `import zipfile; z=zipfile.ZipFile('${zipSrc}','w'); import os; [z.write(os.path.join(r,f),f) for r,_,fs in os.walk('${srcDir}') for f in fs]`]);
  zipMod.extractZip(zipSrc, out, ['META-INF/']);
  assert(fs.existsSync(path.join(out, 'hello.txt')), '解压文件缺失');
  assert(fs.readFileSync(path.join(out, 'hello.txt'), 'utf-8') === 'hello-native', '解压内容错误');
  assert(!fs.existsSync(path.join(out, 'META-INF')), '排除规则未生效');
});

await test('T14 启动参数生成（变量替换/内存/直连服务器/classpath）', async () => {
  await ctrl('ok');
  fs.writeFileSync(path.join(USERDATA, 'settings.json'), JSON.stringify({ sourceMode: 'auto' }));
  const { json } = await versionsMod.fetchVersionJson('mock-1.0', GAMEDIR);
  const files = await versionsMod.buildResources(json, GAMEDIR);
  assert(files.length >= 5, `资源清单过少: ${files.length}`);
  const r = await downloader.runDownloads(files, { onProgress: () => undefined });
  assert(r.failed.length === 0, `资源下载失败: ${r.failed[0]?.error}`);
  launcher.extractNatives(json, GAMEDIR);
  const args = launcher.buildLaunchArgs(json, {
    versionId: 'mock-1.0',
    username: 'TestPlayer',
    javaPath: '/usr/bin/java',
    memoryGB: 3,
    gameDir: GAMEDIR,
    serverAddress: '127.0.0.1',
    serverPort: 25565,
  });
  const joined = args.join(' ');
  assert(args.includes('-Xmx3G'), '内存参数未替换');
  assert(!args.includes('-Xmx2G'), '默认内存残留');
  assert(joined.includes('--version mock-1.0'), '版本名未替换');
  assert(joined.includes('--demo'), 'game 参数丢失');
  assert(joined.includes('--gameDir'), 'gameDir 参数丢失');
  const cpIdx = args.indexOf('-cp');
  assert(cpIdx >= 0, '缺少 -cp');
  const cp = args[cpIdx + 1];
  assert(cp.includes('lib1-1.0.jar') && cp.includes('lib2-1.0.jar') && cp.includes('natives-linux.jar') && cp.includes('mock-1.0.jar'), `classpath 内容缺失: ${cp}`);
  assert(joined.includes('--server 127.0.0.1 --port 25565'), '直连服务器参数缺失');
  assert(joined.includes('${') === false, '存在未替换变量');
  assert(args.includes('net.minecraft.client.main.Main'), 'mainClass 缺失');
  // 内存参数必须在主类之前，否则会被游戏当成参数忽略（日志：Completely ignored arguments）
  const mainIdx = args.indexOf('net.minecraft.client.main.Main');
  assert(args.indexOf('-Xmx3G') < mainIdx, '-Xmx 被放在主类之后');
});

await test('T14b 规则语义：最后一条命中的规则生效', async () => {
  const { applyRules } = versionsMod;
  assert(applyRules([{ action: 'allow' }, { action: 'disallow' }]) === false, '后置 disallow 未生效');
  assert(applyRules([{ action: 'disallow' }, { action: 'allow' }]) === true, '后置 allow 未生效');
  assert(applyRules([{ action: 'allow', os: { name: 'windows' } }]) === false, '不命中的规则应排除');
  assert(applyRules(undefined) === true, '无规则应包含');
});

// ---- 汇总 ----
mockProc.kill();
const failed = results.filter((r) => !r.ok);
console.log('\n========== 自测结果 ==========');
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
console.log('全部通过');
process.exit(0);
