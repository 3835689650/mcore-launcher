// 真机 e2e 自测（CJS 版，与真实主进程运行方式一致）：
// UI（导航/主题/玻璃/多语言）、Java 探测、真实版本列表、真实源测速、
// 真实下载 1.21.1（1B1T 无客户端资源→自动降级 BMCLAPI）+ Java 21 真启动游戏、
// 服务器配置源（镜像无 servers/index.json → 按需求报无法访问）
// 用法：npm run build && npx electron scripts/e2e-test.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// stdout 在管道/重定向下全缓冲，用 fs.writeSync 直写 fd1 保证日志实时可见
const log = (msg) => fs.writeSync(1, `${msg}\n`);

async function main() {
  log('[e2e] 脚本启动');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-e2e-'));
  app.setPath('userData', TMP);
  const GAMEDIR = path.join(os.homedir(), '.minecraft'); // 真实游戏目录（真启动用标准位）
  log(`[e2e] userData=${TMP}`);

  const { registerIpc } = require('../dist-electron/ipc.js');

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

  await app.whenReady();
  log('[e2e] app ready，注册 IPC');
  registerIpc();

  const win = new BrowserWindow({
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

  await test('E2 设置默认值（自动模式/跟随系统/玻璃开/账户与壁纸）', async () => {
    const s = await js(`window.mcore.getSettings()`);
    assert(s.sourceMode === 'auto', `默认源模式: ${s.sourceMode}`);
    assert(s.theme === 'system', `默认主题: ${s.theme}`);
    assert(s.glassEnabled === true, '默认玻璃应开启');
    assert(s.memoryGB === 2, '默认内存应为 2G');
    assert(Array.isArray(s.accounts) && s.currentAccount === '', '账户字段缺失');
    assert(typeof s.wallpaper === 'string', '壁纸字段缺失');
  });

  await test('E2b 账户添加与切换', async () => {
    await js(`window.mcore.setSettings({ accounts: [{ name: 'TestPlayer' }], currentAccount: 'TestPlayer' })`);
    const s = await js(`window.mcore.getSettings()`);
    assert(s.accounts.length === 1 && s.accounts[0].name === 'TestPlayer', '账户未保存');
    assert(s.currentAccount === 'TestPlayer', '当前账户未保存');
  });

  await test('E3 主题切换（亮/暗/跟随系统，含持久化）', async () => {
    await js(`window.mcore.setSettings({ theme: 'dark' })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
    assert((await js(`document.documentElement.getAttribute('data-theme')`)) === 'dark', '暗色未生效');
    await js(`window.mcore.setSettings({ theme: 'light' })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
    assert((await js(`document.documentElement.getAttribute('data-theme')`)) === 'light', '亮色未生效');
    await js(`window.mcore.setSettings({ theme: 'system' })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
  });

  await test('E4 液态玻璃：开关 + 透明度联动（含持久化）', async () => {
    await js(`window.mcore.setSettings({ glassEnabled: true, glassOpacity: 35 })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
    const on = await js(`({ g: document.getElementById('root').querySelector('[data-glass]')?.getAttribute('data-glass'), a: document.getElementById('root').querySelector('[data-glass]')?.style.getPropertyValue('--glass-alpha') })`);
    assert(on.g === 'on', `玻璃未开启: ${on.g}`);
    assert(on.a.trim() === '35', `透明度未联动: ${on.a}`);
    await js(`window.mcore.setSettings({ glassEnabled: false })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
    const off = await js(`document.getElementById('root').querySelector('[data-glass]')?.getAttribute('data-glass')`);
    assert(off === 'off', '玻璃未关闭');
    await js(`window.mcore.setSettings({ glassEnabled: true, glassOpacity: 70 })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
  });

  await test('E5 多语言切换（持久化 + 重载生效）', async () => {
    await js(`window.mcore.setSettings({ language: 'zh-TW' })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
    const nav = await js(`Array.from(document.querySelectorAll('nav button')).map(b => b.textContent.trim()).join(',')`);
    assert(nav.includes('啟動'), `繁体未生效: ${nav}`);
    await js(`window.mcore.setSettings({ language: 'en-US' })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
    const nav2 = await js(`Array.from(document.querySelectorAll('nav button')).map(b => b.textContent.trim()).join(',')`);
    assert(nav2.includes('Settings'), `英文未生效: ${nav2}`);
    await js(`window.mcore.setSettings({ language: 'system' })`);
    win.reload();
    await new Promise((r) => setTimeout(r, 2500));
  });

  await test('E6 Java 探测（本机应发现 Java 21/25）', async () => {
    const list = await js(`window.mcore.scanJava()`);
    assert(list.length > 0, '未发现任何 Java');
    assert(list.some((j) => j.major === 21), `未发现 Java 21: ${list.map((j) => j.major).join(',')}`);
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
      await js(`
        window.__e2eLogs = [];
        window.mcore.onLaunchLog((l) => window.__e2eLogs.push(l.line));
        window.mcore.onLaunchExit(() => { window.__e2eExited = true; });
        true;
      `);
      log('      开始真实下载（1B1T 无客户端资源 → 应自动降级 BMCLAPI）…');
      const r = await js(`window.mcore.launch({ versionId: '1.21.1', username: 'TestPlayer', javaPath: '', memoryGB: 2, gameDir: '${GAMEDIR}', serverAddress: '', serverPort: 25565 })`);
      assert(r.ok === true, `启动流程失败: ${r.error}`);
      log('      资源下载完成，游戏进程已 spawn');
      await new Promise((res) => setTimeout(res, 25000));
      // 硬验证：java 进程存在且命令行参数完整（-cp/classpath/版本/用户名）
      const { execSync } = require('node:child_process');
      const psOut = execSync(`ps -eo args | grep [j]ava | grep '1.21.1' | head -1 || true`).toString();
      assert(psOut.length > 0, '未找到 java 游戏进程');
      assert(psOut.includes('-cp'), `命令行缺少 -cp: ${psOut.slice(0, 120)}`);
      assert(psOut.includes('TestPlayer'), '命令行缺少用户名');
      assert(psOut.includes('-Djava.library.path'), '命令行缺少 natives 路径参数');
      log(`      java 进程命令行验证通过（含 -cp/用户名/natives）`);
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

  await test('E10 服务器配置源（镜像已部署 servers/index.json → 正常读取）', async () => {
    const r = await js(
      `window.mcore.getServerIndex().then(x => ({ ok: true, servers: Array.isArray(x.servers), cores: x.coreFiles?.length ?? 0 })).catch(e => ({ ok: false, err: String(e) }))`,
    );
    assert(r.ok === true, `应成功读取: ${r.err ?? ''}`);
    assert(r.servers === true, 'servers 字段异常');
    assert(r.cores > 0, 'coreFiles 应为非空');
    log(`      服务器索引读取成功（核心文件 ${r.cores} 条）`);
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
}

main().catch((e) => {
  log(`[e2e] 致命错误: ${e?.stack ?? e}`);
  app.exit(1);
});
