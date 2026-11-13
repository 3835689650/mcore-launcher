// 真机 e2e 自测：在真实 Electron 环境加载渲染进程，验证
// UI（导航/主题/玻璃/多语言）、Java 探测、真实版本列表、真实源测速、
// 真实下载 1.21.1（1B1T 无客户端资源→自动降级 BMCLAPI）+ Java 21 真启动游戏、
// 服务器配置源（镜像无 servers/index.json → 按需求报无法访问）
// 用法：npm run build && npx electron scripts/e2e-test.mjs
import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// stdout 在管道/重定向下全缓冲，用 fs.writeSync 直写 fd1 保证日志实时可见
const log = (msg) => fs.writeSync(1, `${msg}\n`);

log('[e2e] 脚本启动');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-e2e-'));
app.setPath('userData', TMP);
const GAMEDIR = path.join(os.homedir(), '.minecraft'); // 真实游戏目录（真启动用标准位）
log(`[e2e] userData=${TMP}`);

const results = [];
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function test(name, fn, timeoutMs = 30000) {
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), timeoutMs));
  try {
    await Promise.race([fn(), timer]);
    results.push({ name, ok: true });
    log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    log(`  FAIL  ${name}: ${e.message}`);
  }
}

log('[e2e] 加载 ipc 模块…');
const { registerIpc } = await import('../dist-electron/ipc.js');
log('[e2e] ipc 已加载，等待 app ready…');

let win;
await app.whenReady();
log('[e2e] app ready，注册 IPC');
registerIpc();
win = new BrowserWindow({
  show: false,
  width: 1280,
  height: 800,
  webPreferences: {
    preload: path.join(process.cwd(), 'dist-electron/preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
await win.loadFile(path.join(process.cwd(), 'dist', 'index.html'));
log('[e2e] 页面已加载');
// 带超时的 executeJavaScript（防挂起）
const js = (code) =>
  Promise.race([
    win.webContents.executeJavaScript(code),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`executeJavaScript 超时: ${code.slice(0, 60)}`)), 20000)),
  ]);

// 等 React 渲染完成
for (let i = 0; i < 40; i++) {
  const ready = await js(`document.querySelectorAll('nav button').length`);
  if (ready >= 4) break;
  await new Promise((r) => setTimeout(r, 500));
}
log('[e2e] 渲染就绪，开始真机自测…');

await test('E1 UI 渲染：导航四页 + 标题', async () => {
  const nav = await js(`Array.from(document.querySelectorAll('nav button')).map(b => b.textContent.trim()).join(',')`);
  assert(nav.includes('启动') || nav.includes('Home'), `导航异常: ${nav}`);
  const h1 = await js(`document.querySelector('main h1')?.textContent ?? ''`);
  assert(h1.length > 0, '主页标题缺失');
});

await test('E2 设置默认值（自动模式/跟随系统/玻璃开）', async () => {
  const s = await js(`window.mcore.getSettings()`);
  assert(s.sourceMode === 'auto', `默认源模式: ${s.sourceMode}`);
  assert(s.theme === 'system', `默认主题: ${s.theme}`);
  assert(s.glassEnabled === true, '默认玻璃应开启');
  assert(s.memoryGB === 2, '默认内存应为 2G');
});

await test('E3 主题切换（亮/暗/跟随系统）', async () => {
  await js(`window.mcore.setSettings({ theme: 'dark' })`);
  await new Promise((r) => setTimeout(r, 400));
  assert((await js(`document.documentElement.getAttribute('data-theme')`)) === 'dark', '暗色未生效');
  await js(`window.mcore.setSettings({ theme: 'light' })`);
  await new Promise((r) => setTimeout(r, 400));
  assert((await js(`document.documentElement.getAttribute('data-theme')`)) === 'light', '亮色未生效');
  await js(`window.mcore.setSettings({ theme: 'system' })`);
});

await test('E4 液态玻璃：开关 + 透明度联动', async () => {
  await js(`window.mcore.setSettings({ glassEnabled: true, glassOpacity: 35 })`);
  await new Promise((r) => setTimeout(r, 400));
  const on = await js(`({ g: document.getElementById('root').querySelector('[data-glass]')?.getAttribute('data-glass'), a: document.getElementById('root').querySelector('[data-glass]')?.style.getPropertyValue('--glass-alpha') })`);
  assert(on.g === 'on', `玻璃未开启: ${on.g}`);
  assert(on.a.trim() === '35', `透明度未联动: ${on.a}`);
  await js(`window.mcore.setSettings({ glassEnabled: false })`);
  await new Promise((r) => setTimeout(r, 400));
  const off = await js(`document.getElementById('root').querySelector('[data-glass]')?.getAttribute('data-glass')`);
  assert(off === 'off', '玻璃未关闭');
  await js(`window.mcore.setSettings({ glassEnabled: true, glassOpacity: 70 })`);
});

await test('E5 多语言切换（持久化 + 重载生效）', async () => {
  await js(`window.mcore.setSettings({ language: 'zh-TW' })`);
  win.reload();
  await new Promise((r) => setTimeout(r, 2000));
  const nav = await js(`Array.from(document.querySelectorAll('nav button')).map(b => b.textContent.trim()).join(',')`);
  assert(nav.includes('啟動'), `繁体未生效: ${nav}`);
  await js(`window.mcore.setSettings({ language: 'en-US' })`);
  win.reload();
  await new Promise((r) => setTimeout(r, 2000));
  const nav2 = await js(`Array.from(document.querySelectorAll('nav button')).map(b => b.textContent.trim()).join(',')`);
  assert(nav2.includes('Settings'), `英文未生效: ${nav2}`);
  await js(`window.mcore.setSettings({ language: 'system' })`);
  win.reload();
  await new Promise((r) => setTimeout(r, 2000));
});

await test('E6 Java 探测（本机应发现 Java 21/25）', async () => {
  const list = await js(`window.mcore.scanJava()`);
  assert(list.length > 0, '未发现任何 Java');
  const majors = list.map((j) => j.major).join(',');
  assert(list.some((j) => j.major === 21), `未发现 Java 21: ${majors}`);
  log(`      发现 ${list.length} 个 Java: ${list.map((j) => `Java ${j.version}(${j.source})`).join(' ')}`);
});

await test('E7 真实版本列表（BMCLAPI 降级链路）', async () => {
  const list = await js(`window.mcore.listVersions()`);
  assert(Array.isArray(list) && list.length > 100, `版本数异常: ${list?.length}`);
  assert(list.some((v) => v.id === '1.21.1'), '缺少 1.21.1');
  log(`      版本列表 ${list.length} 条（含 1.21.1）`);
});

await test('E8 真实源测速（1B1T/BMCLAPI/官方）', async () => {
  const r = await js(`window.mcore.testSources()`);
  assert(r.length === 3, `源数量: ${r.length}`);
  for (const s of r) {
    log(`      ${s.name}: ${s.ok ? 'OK' : 'FAIL'} ${s.speedKBs}KB/s ${s.latencyMs}ms${s.ok ? '' : ' ' + s.error}`);
  }
  assert(r.some((s) => s.ok), '全部源不可用');
});

await test(
  'E9 真实下载 1.21.1 + Java 21 真启动游戏（含自动降级与 SHA1 校验）',
  async () => {
    // 订阅日志与退出
    await js(`
      window.__e2eLogs = [];
      window.mcore.onLaunchLog((l) => window.__e2eLogs.push(l.line));
      window.mcore.onLaunchExit(() => { window.__e2eExited = true; });
      true;
    `);
    const r = await js(`window.mcore.launch({ versionId: '1.21.1', username: 'TestPlayer', javaPath: '', memoryGB: 2, gameDir: '${GAMEDIR}', serverAddress: '', serverPort: 25565 })`);
    assert(r.ok === true, `启动流程失败: ${r.error}`);
    log('      资源下载完成，游戏进程已 spawn');
    // 等日志输出（游戏启动输出）
    await new Promise((res) => setTimeout(res, 20000));
    const logs = await js(`window.__e2eLogs.join('\\n')`);
    assert(logs.length > 100, '游戏无日志输出');
    log(`      日志 ${logs.length} 字符，进程存活`);
    await js(`window.mcore.stopLaunch()`);
    await new Promise((res) => setTimeout(res, 2000));
    const exited = await js(`window.__e2eExited === true`);
    assert(exited, '未收到退出事件');
  },
  900000,
);

await test('E10 服务器配置源（镜像无 servers/index.json → 按需求报无法访问）', async () => {
  const r = await js(`window.mcore.getServerIndex().then(() => ({ok:true})).catch(e => ({ok:false, err: String(e)}))`);
  assert(r.ok === false, '应报错');
  assert(/服务器配置源无法访问/.test(r.err), `错误信息不符: ${r.err}`);
  log(`      按需求正确报错: ${r.err.slice(0, 60)}`);
});

// ---- 汇总 ----
log('\n========== e2e 自测结果 ==========');
const failed = results.filter((x) => !x.ok);
log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length > 0) {
  for (const f of failed) log(`  FAIL  ${f.name}: ${f.err}`);
  app.exit(1);
} else {
  log('全部通过');
  app.exit(0);
}
