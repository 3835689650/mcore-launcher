// IPC 处理器：渲染进程调用的全部能力在此注册
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getMirrors, getSettings, resolveGameDir, setSettings } from './config';
import { runDownloads, type ResourceFile } from './downloader';
import { httpDownload } from './http';
import { buildLaunchArgs, consumeStopRequest, launchGame, stopGame, validateOfflineUsername, extractNatives } from './launcher';
import { pickJava, requiredJavaMajor, scanJava } from './java';
import {
  applyModUpdate,
  checkModUpdates,
  deleteMod,
  installMod,
  listInstalledMods,
  listModVersions,
  searchMods,
  setModEnabled,
} from './mods';
import { fetchServerIndex } from './servers';
import { getClientSourceChain, getServerSource } from './sources';
import { testAllSources } from './speedtest';
import { buildResources, fetchManifest, fetchVersionJson, versionReady } from './versions';
import type { DownloadProgress, DownloadTask, LaunchCrash, LaunchLog, LaunchOptions } from './types';

// ---- 下载会话状态 ----
let downloadAbort = false;
let downloadRunning = false;

function pushDownload(task: DownloadTask, doneCount: number, totalCount: number) {
  const p: DownloadProgress = { task, doneCount, totalCount };
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('download-progress', p);
  }
}

/** 计算文件 SHA256（临时关闭 Electron 的 asar 路径映射，否则 app.asar 会被当成虚拟目录、读到 0 字节） */
async function sha256Plain(p: string): Promise<string> {
  const proc = process as unknown as { noAsar?: boolean };
  const prev = proc.noAsar;
  proc.noAsar = true;
  try {
    const { sha256File } = await import('./downloader');
    return await sha256File(p);
  } finally {
    proc.noAsar = prev;
  }
}

/** 下载结束通知（成功/失败/取消都发，避免界面一直停在「下载中」） */
function pushDownloadEnd(ok: boolean, failed: DownloadTask[], error: string) {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('download-end', { ok, failed: failed.length, error });
  }
}

/** 失败任务转成给用户看的错误文案 */
function failSummary(failed: DownloadTask[]): string {
  if (failed.length === 0) return '';
  const names = failed.slice(0, 3).map((t) => t.name).join('、');
  return `${failed.length} 个文件下载失败（${names}${failed.length > 3 ? ' 等' : ''}），请检查网络或切换资源源后重试`;
}

/** 下载版本资源（增量：已完整文件跳过） */
async function downloadVersion(versionId: string): Promise<{ ok: boolean; error: string }> {
  if (downloadRunning) return { ok: false, error: '已有下载任务进行中' };
  downloadRunning = true;
  downloadAbort = false;
  try {
    const gameDir = resolveGameDir();
    const { json } = await fetchVersionJson(versionId, gameDir);
    const files: ResourceFile[] = await buildResources(json, gameDir);
    const res = await runDownloads(files, {
      onProgress: (task, doneCount, totalCount) => pushDownload(task, doneCount, totalCount),
      shouldAbort: () => downloadAbort,
    });
    if (downloadAbort) {
      pushDownloadEnd(false, [], '已取消');
      return { ok: false, error: '已取消' };
    }
    if (res.failed.length > 0) {
      const error = failSummary(res.failed);
      pushDownloadEnd(false, res.failed, error);
      return { ok: false, error };
    }
    pushDownloadEnd(true, [], '');
    return { ok: true, error: '' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    pushDownloadEnd(false, [], error);
    return { ok: false, error };
  } finally {
    downloadRunning = false;
  }
}

const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000; // 存档自动备份最短间隔
const LAUNCH_LOG_LIMIT = 4000; // 崩溃分析保留的日志行数
let launchLogBuffer: string[] = [];

/** 退出码非 0 时提取崩溃摘要（异常行 + Caused by + 最新 crash-report） */
function analyzeCrash(gameDir: string, code: number | null): LaunchCrash {
  const lines = launchLogBuffer.slice(-LAUNCH_LOG_LIMIT);
  const pick = (re: RegExp): string => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (re.test(lines[i])) return lines[i].trim();
    }
    return '';
  };
  const summary = pick(/Exception|Error|fatal|crash|Failed/i) || `游戏进程退出（代码 ${code ?? 'null'}）`;
  const causedBy = pick(/Caused by:/i);
  let crashPath = '';
  try {
    const dir = path.join(gameDir, 'crash-reports');
    const reports = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .sort();
    if (reports.length > 0) crashPath = path.join(dir, reports[reports.length - 1]);
  } catch {
    // 没有崩溃报告
  }
  const logDir = path.join(app.getPath('userData'), 'logs');
  let logPath = '';
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, 'last-launch.log');
    fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');
  } catch {
    logPath = '';
  }
  return {
    code,
    summary: summary.slice(0, 400),
    causedBy: causedBy.slice(0, 400),
    detail: lines.slice(-200).join('\n').slice(-12000),
    crashPath,
    logPath,
    gameDir,
  };
}

/** 启动前快照 saves：1 小时内已备份则跳过（保留最近 10 份） */
function autoBackupSaves(gameDir: string, versionId: string, sendLog: (l: LaunchLog) => void): void {
  const savesDir = path.join(gameDir, 'saves');
  if (!fs.existsSync(savesDir)) return;
  try {
    const backupRoot = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(backupRoot, { recursive: true });
    const statePath = path.join(backupRoot, '.last-backup');
    try {
      const last = Number(fs.readFileSync(statePath, 'utf-8'));
      if (Number.isFinite(last) && Date.now() - last < BACKUP_MIN_INTERVAL_MS) return;
    } catch {
      // 首次备份
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupRoot, `${versionId}-${stamp}`);
    fs.cpSync(savesDir, dest, { recursive: true });
    fs.writeFileSync(statePath, String(Date.now()), 'utf-8');
    sendLog({ line: `[备份] 存档已自动备份到 ${dest}\n`, stream: 'info' });
    // 清理旧备份：保留最近 10 份
    const entries = fs
      .readdirSync(backupRoot)
      .filter((n) => !n.startsWith('.'))
      .map((n) => ({ n, m: fs.statSync(path.join(backupRoot, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const e of entries.slice(10)) {
      fs.rmSync(path.join(backupRoot, e.n), { recursive: true, force: true });
    }
  } catch {
    // 备份失败不阻塞启动
  }
}

/** 完整启动流程：校验 → Java → 资源 → natives → 启动 */
async function launchFlow(opts: LaunchOptions): Promise<{ ok: boolean; error: string }> {
  const nameErr = validateOfflineUsername(opts.username);
  if (nameErr) return { ok: false, error: nameErr };

  const gameDir = resolveGameDir();
  const win = BrowserWindow.getAllWindows()[0];
  launchLogBuffer = [];
  const sendLog = (log: LaunchLog) => {
    if (log.line) {
      for (const ln of log.line.split(/\r?\n/)) {
        if (ln.trim()) launchLogBuffer.push(ln);
      }
      if (launchLogBuffer.length > LAUNCH_LOG_LIMIT * 2) {
        launchLogBuffer = launchLogBuffer.slice(-LAUNCH_LOG_LIMIT);
      }
    }
    win?.webContents.send('launch-log', log);
  };
  const sendExit = (code: number | null) => {
    win?.webContents.send('launch-exit', code);
    if (code !== 0 && !consumeStopRequest()) {
      try {
        win?.webContents.send('launch-crash', analyzeCrash(gameDir, code));
      } catch {
        // 崩溃分析失败不影响退出流程
      }
    }
  };

  const tStart = Date.now();
  let tJava = 0;
  let tRes = 0;

  try {
    // 1. version json（原版必须就位；加载器安装基于原版 json）
    const { json } = await fetchVersionJson(opts.versionId, gameDir);
    let versionId = opts.versionId;
    let versionJson = json;

    // 1.5 模组加载器部署（改造版 version json）
    if (opts.loaderKind && opts.loaderVersion) {
      const { fetchApiMod, installApiMod, installLoader } = await import('./loaders');
      versionId = await installLoader(opts.loaderKind, opts.versionId, opts.loaderVersion, gameDir);
      sendLog({
        line: `[加载器] ${opts.loaderKind} ${opts.loaderVersion} 部署完成 → ${versionId}\n`,
        stream: 'info',
      });
      // 基础 API mod → mods 文件夹
      if (opts.apiSlug) {
        const api = await fetchApiMod(opts.apiSlug, opts.versionId, opts.loaderKind === 'quilt' ? 'quilt' : 'fabric');
        await installApiMod(api.url, api.name, opts.versionId, gameDir);
        sendLog({ line: `[API] ${api.name} 已部署到 mods/\n`, stream: 'info' });
      }
      const { json: newJson } = await fetchVersionJson(versionId, gameDir);
      versionJson = newJson;
    }

    // 2. Java 匹配
    let javaPath = opts.javaPath;
    if (!javaPath) {
      const runtimes = await scanJava();
      const required = requiredJavaMajor(opts.versionId, versionJson.javaVersion?.majorVersion);
      let picked = pickJava(runtimes, required);
      if (!picked) {
        // 自动安装 Java（TUNA Adoptium 镜像 → userData/jre）
        sendLog({ line: `[Java] 未找到 Java ${required}，自动安装中…\n`, stream: 'info' });
        const { downloadJava } = await import('./java');
        const installed = await downloadJava(required, (m) => sendLog({ line: `[Java] ${m}\n`, stream: 'info' }));
        if (!installed) {
          return {
            ok: false,
            error: `Java ${required} 自动安装失败，请在设置中手动指定 Java 路径`,
          };
        }
        sendLog({ line: `[Java] 已安装 ${installed.version}（${installed.path}）\n`, stream: 'info' });
        picked = installed;
      }
      javaPath = picked.path;
    }
    tJava = Date.now() - tStart;

    // 3. 资源就位检查 + 下载（改造版 json 的原版资源与依赖库）
    const ready = await versionReady(versionJson, gameDir);
    if (!ready) {
      downloadRunning = true;
      downloadAbort = false;
      let res: { failed: DownloadTask[] } = { failed: [] };
      try {
        const files: ResourceFile[] = await buildResources(versionJson, gameDir);
        res = await runDownloads(files, {
          onProgress: (task, doneCount, totalCount) => pushDownload(task, doneCount, totalCount),
          shouldAbort: () => downloadAbort,
        });
      } finally {
        downloadRunning = false;
        pushDownloadEnd(!downloadAbort && res.failed.length === 0, res.failed, failSummary(res.failed));
      }
      if (downloadAbort) return { ok: false, error: '已取消' };
      if (res.failed.length > 0) return { ok: false, error: failSummary(res.failed) };
    }
    tRes = Date.now() - tStart - tJava;

    // 3.5 自动备份存档（节流：1 小时内只备份一次，避免每次启动都同步拷贝几十上百 MB）
    const tBackup = Date.now();
    autoBackupSaves(gameDir, opts.versionId, sendLog);
    const backupMs = Date.now() - tBackup;

    // 4. natives 解压（签名未变则跳过）
    const tNatives = Date.now();
    extractNatives(versionJson, gameDir);
    const nativesMs = Date.now() - tNatives;

    // 5. 参数生成与启动（改造版 versionId）
    const args = buildLaunchArgs(versionJson, { ...opts, versionId, gameDir });
    sendLog({
      line: `[启动] 前置耗时 ${Date.now() - tStart}ms（Java ${tJava}ms / 资源 ${tRes}ms / 备份 ${backupMs}ms / natives ${nativesMs}ms）\n`,
      stream: 'info',
    });
    sendLog({ line: `启动命令: ${javaPath} ${args.join(' ')}\n`, stream: 'info' });
    await launchGame(javaPath, args, gameDir, sendLog, sendExit);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 注册全部 IPC */
export function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch) => setSettings(patch));
  ipcMain.handle('mirrors:get', () => getMirrors());
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    gameDir: resolveGameDir(),
  }));

  // 更新检测：拉官网 latest.json 对比当前版本
  ipcMain.handle('update:check', async () => {
    try {
      const tmp = path.join(os.tmpdir(), `mcore-latest-${process.pid}.json`);
      const r = await httpDownload('https://www.1b1t.cn/mcore/latest.json', tmp, { timeoutMs: 8000 });
      if (!r.ok) return { hasUpdate: false, latest: '', note: '', url: '' };
      const parsed = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as {
        version?: string;
        note?: string;
        url?: string;
      };
      fs.unlinkSync(tmp);
      const current = app.getVersion();
      const latest = parsed.version ?? '';
      // 版本号数值比较：仅在新版号更大时提示
      const pa = latest.split('.').map((x) => parseInt(x, 10) || 0);
      const pb = current.split('.').map((x) => parseInt(x, 10) || 0);
      let hasUpdate = false;
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) {
          hasUpdate = d > 0;
          break;
        }
      }
      return { hasUpdate, latest, note: parsed.note ?? '', url: parsed.url ?? '' };
    } catch {
      return { hasUpdate: false, latest: '', note: '', url: '' };
    }
  });

  // 自动更新（HMCL 式）：优先差分（listing 对比只拉变更文件），不可用回退完整包
  ipcMain.handle('update:apply', async () => {
    try {
      // 拉 latest.json 取版本与差分清单地址
      const tmpJson = path.join(os.tmpdir(), `mcore-latest-${process.pid}.json`);
      const r0 = await httpDownload('https://www.1b1t.cn/mcore/latest.json', tmpJson, { timeoutMs: 8000 });
      if (!r0.ok) return { ok: false, error: '无法连接更新服务器' };
      const parsed = JSON.parse(fs.readFileSync(tmpJson, 'utf-8')) as Record<string, string>;
      fs.unlinkSync(tmpJson);
      const latest = parsed.version ?? '';
      if (!latest) return { ok: false, error: '更新服务器数据异常' };

      const win = BrowserWindow.getAllWindows()[0];
      const pushProgress = (received: number, total: number) => {
        win?.webContents.send('update-progress', { received, total, latest });
      };

      // ---- 差分路径：仅 resources 可写时启用；AppImage（squashfs 只读）/系统 deb（root 属主）走完整包 ----
      const canWriteResources = (() => {
        try {
          const probe = path.join(process.resourcesPath, '.mcore-wtest');
          fs.writeFileSync(probe, 'x');
          fs.unlinkSync(probe);
          return true;
        } catch {
          return false;
        }
      })();
      const asarPath = path.join(process.resourcesPath, 'app.asar');
      const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
      const isDiffAble = canWriteResources && fs.existsSync(asarPath) && fs.existsSync(unpackedDir);
      if (isDiffAble) {
        try {
          const listingPath = path.join(os.tmpdir(), `mcore-listing-${process.pid}.json`);
          const rl = await httpDownload(`https://mcdown.cn-nb1.rains3.com/update/${latest}/listing.json`, listingPath, { timeoutMs: 15000 });
          if (rl.ok) {
            const listing = JSON.parse(fs.readFileSync(listingPath, 'utf-8')) as {
              version?: string;
              asar?: string;
              files?: Record<string, string>;
            };
            fs.unlinkSync(listingPath);
            // 依赖层（app.asar，含 node_modules）必须与服务器一致，否则必须整包更新
            const asarMatch = !listing.asar || (await sha256Plain(asarPath)) === listing.asar;
            if (asarMatch) {
              const files = listing.files ?? {};
              // 对比本地文件（app.asar.unpacked/dist、locales 等）：缺失或不一致 → 需下载
              const pending: { rel: string; sha: string }[] = [];
              for (const [rel, sha] of Object.entries(files)) {
                const lp = path.join(process.resourcesPath, rel);
                if (!fs.existsSync(lp) || (await sha256Plain(lp)) !== sha) {
                  pending.push({ rel, sha });
                }
              }
              // 差异文件下载 + 校验 + 覆盖
              let done = 0;
              for (const item of pending) {
                const dest = path.join(process.resourcesPath, item.rel);
                const r = await httpDownload(
                  `https://mcdown.cn-nb1.rains3.com/update/${latest}/${item.rel}`,
                  `${dest}.new`,
                  { timeoutMs: 20000, onProgress: (recv, total) => pushProgress(done * 1e6 + recv, pending.length * 1e6) },
                );
                if (!r.ok || (await sha256Plain(`${dest}.new`)) !== item.sha) {
                  try { fs.unlinkSync(`${dest}.new`); } catch { /* 忽略 */ }
                  return { ok: false, error: `差分更新失败（${item.rel}），请重试` };
                }
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.renameSync(`${dest}.new`, dest);
                done += 1;
              }
              if (pending.length === 0) return { ok: true, needRestart: false, upToDate: true };
              pushProgress(1, 1);
              setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
              return { ok: true, error: '', needRestart: false };
            }
          }
          try { fs.unlinkSync(listingPath); } catch { /* 忽略 */ }
        } catch {
          // 差分失败 → 回退完整包
        }
      }
      return applyFullUpdate(parsed, latest, pushProgress);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 完整包更新（差分不可用时的回退路径） */
  async function applyFullUpdate(
    parsed: Record<string, string>,
    latest: string,
    pushProgress: (received: number, total: number) => void,
  ): Promise<{ ok: boolean; error: string; needRestart: boolean; upToDate?: boolean; manual?: boolean }> {
    try {
      const isMac = process.platform === 'darwin';
      const macArm = process.arch === 'arm64';
      const dlUrl = isMac
        ? macArm
          ? parsed.macArm64Url || parsed.macUrl
          : parsed.macX64Url || parsed.macUrl
        : process.platform === 'win32'
          ? parsed.winUrl
          : process.env.APPIMAGE
            ? parsed.appimageUrl
            : parsed.debUrl;
      if (!dlUrl || !latest) return { ok: false, error: '更新服务器缺少安装包地址', needRestart: false };

      const pkgExt = isMac ? '.zip' : process.platform === 'win32' ? '.exe' : process.env.APPIMAGE ? '.AppImage' : '.deb';
      const expectSha = isMac
        ? macArm
          ? parsed.macArm64Sha256 || parsed.macSha256
          : parsed.macX64Sha256 || parsed.macSha256
        : process.platform === 'win32'
          ? parsed.winSha256
          : process.env.APPIMAGE
            ? parsed.appimageSha256
            : parsed.debSha256;
      const pkgPath = path.join(os.tmpdir(), `mcore-update-${latest}${pkgExt}`);
      const win = BrowserWindow.getAllWindows()[0];

      // 下载 + 完整性校验（SHA256 不符则重下一次，仍不符报错）
      let shaOk = false;
      for (let attempt = 0; attempt < 2 && !shaOk; attempt += 1) {
        const dl = await httpDownload(dlUrl, pkgPath, {
          timeoutMs: 20000,
          onProgress: (received, total) => {
            win?.webContents.send('update-progress', { received, total, latest });
          },
        });
        if (!dl.ok) return { ok: false, error: `下载失败: ${dl.error}`, needRestart: false };
        if (!expectSha) {
          shaOk = true;
          break;
        }
        const { sha256File } = await import('./downloader');
        const h = await sha256File(pkgPath);
        if (h === expectSha) {
          shaOk = true;
        } else if (attempt === 0) {
          try {
            fs.unlinkSync(pkgPath);
          } catch {
            // 忽略
          }
        }
      }
      if (!shaOk) {
        try {
          fs.unlinkSync(pkgPath);
        } catch {
          // 忽略
        }
        return { ok: false, error: '安装包完整性校验失败，请重试', needRestart: false };
      }

      const relaunch = () => {
        // 更新完成自动重启启动器
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 800);
      };

      if (isMac) {
        // macOS（zip 版，未签名）：下载到「下载」文件夹，由用户解压替换（无法在运行时安全覆写 .app）
        const { shell } = await import('electron');
        const dest = path.join(os.homedir(), 'Downloads', path.basename(pkgPath));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(pkgPath, dest);
        try {
          fs.unlinkSync(pkgPath);
        } catch {
          // 忽略
        }
        shell.showItemInFolder(dest);
        return { ok: true, error: '', needRestart: true, manual: true };
      }
      if (process.platform === 'win32') {
        // NSIS 静默安装（安装器覆写安装后自动重启应用）
        const { spawn } = await import('child_process');
        spawn(pkgPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
        app.quit();
      } else if (process.env.APPIMAGE) {
        // AppImage：覆写自身（单份文件，不残留旧版）
        fs.chmodSync(pkgPath, 0o755);
        fs.copyFileSync(pkgPath, process.env.APPIMAGE);
        fs.unlinkSync(pkgPath);
        relaunch();
      } else {
        // deb：pkexec 提权安装（dpkg 覆盖，单份安装）
        const { execFile } = await import('child_process');
        await new Promise<void>((resolve) => {
          execFile('pkexec', ['dpkg', '-i', pkgPath], (err) => {
            if (err) {
              // 提权被拒：包放到下载目录供手动安装（兜底）
              try {
                fs.copyFileSync(pkgPath, path.join(os.homedir(), 'Downloads', path.basename(pkgPath)));
              } catch {
                // 忽略
              }
            }
            try {
              fs.unlinkSync(pkgPath);
            } catch {
              // 忽略
            }
            resolve();
          });
        });
        relaunch();
      }
      return { ok: true, error: '', needRestart: false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), needRestart: false };
    }
  }

  ipcMain.handle('sources:test', async () => testAllSources(getMirrors().clientSources));
  ipcMain.handle('sources:chain', () => getClientSourceChain());

  ipcMain.handle('versions:list', async () => (await fetchManifest()).entries);

  ipcMain.handle('loaders:list', async (_e, mcVersion: string) => {
    const { listLoaders } = await import('./loaders');
    return listLoaders(mcVersion);
  });

  // 版本安装（HMCL 式）：下载原版资源 + 可选部署模组加载器
  ipcMain.handle('version:install', async (_e, versionId: string, loaderKind: string, loaderVersion: string) => {
    if (downloadRunning) return { ok: false, error: '已有下载任务进行中' };
    downloadRunning = true;
    downloadAbort = false;
    try {
      const gameDir = resolveGameDir();
      const { json } = await fetchVersionJson(versionId, gameDir);
      const files: ResourceFile[] = await buildResources(json, gameDir);
      const res = await runDownloads(files, {
        onProgress: (task, doneCount, totalCount) => pushDownload(task, doneCount, totalCount),
        shouldAbort: () => downloadAbort,
      });
      if (downloadAbort) {
        pushDownloadEnd(false, [], '已取消');
        return { ok: false, error: '已取消' };
      }
      if (res.failed.length > 0) {
        const error = failSummary(res.failed);
        pushDownloadEnd(false, res.failed, error);
        return { ok: false, error };
      }
      pushDownloadEnd(true, [], '');
      // 加载器部署（生成改造版 version json + 依赖库）
      let resultId = versionId;
      if (loaderKind && loaderVersion) {
        const { installLoader } = await import('./loaders');
        resultId = await installLoader(
          loaderKind as 'forge' | 'neoforge' | 'fabric' | 'quilt',
          versionId,
          loaderVersion,
          gameDir,
        );
      }
      return { ok: true, error: '', versionId: resultId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      downloadRunning = false;
    }
  });

  // 删除本地版本资源（版本目录；libraries/assets 为共享资源保留）
  ipcMain.handle('versions:delete', (_e, versionId: string) => {
    try {
      const dir = path.join(resolveGameDir(), 'versions', versionId);
      if (!fs.existsSync(dir)) return { ok: true };
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 判断版本资源是否已就绪（本地 version json + client jar SHA1 匹配），防重复下载
  ipcMain.handle('versions:ready', async (_e, versionId: string) => {
    const gameDir = resolveGameDir();
    try {
      const jsonPath = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
      if (!fs.existsSync(jsonPath)) return { ready: false };
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { downloads?: { client?: { sha1?: string } } };
      const jarPath = path.join(gameDir, 'versions', versionId, `${versionId}.jar`);
      if (!fs.existsSync(jarPath)) return { ready: false };
      const sha1 = parsed.downloads?.client?.sha1;
      if (sha1) {
        const { sha1File } = await import('./downloader');
        return { ready: (await sha1File(jarPath)) === sha1 };
      }
      return { ready: true };
    } catch {
      return { ready: false };
    }
  });

  // 本地已安装版本（含加载器改造版：Home 页据此提供启动入口）
  ipcMain.handle('versions:installed', () => {
    const gameDir = resolveGameDir();
    const dir = path.join(gameDir, 'versions');
    const out: { id: string; type: string; releaseTime: string; loader: string; mcVersion: string }[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const jsonPath = path.join(dir, name, `${name}.json`);
      try {
        const j = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as {
          id?: string;
          type?: string;
          releaseTime?: string;
          inheritsFrom?: string;
        };
        const id = j.id || name;
        const loader = /(?:^|[-_])(forge|neoforge|fabric|quilt)(?:[-_]|$)/i.exec(id)?.[1]?.toLowerCase() ?? '';
        const mcVersion = /(\d+\.\d+(?:\.\d+)?)/.exec(j.inheritsFrom || id)?.[1] ?? '';
        out.push({
          id,
          type: j.type ?? (j.inheritsFrom ? 'loader' : 'release'),
          releaseTime: j.releaseTime ?? '',
          loader,
          mcVersion,
        });
      } catch {
        // 不是有效版本目录
      }
    }
    out.sort((a, b) => (b.releaseTime || '').localeCompare(a.releaseTime || '') || a.id.localeCompare(b.id));
    return out;
  });

  // ---- 模组（Modrinth：元数据官方 API，文件镜像优先）----
  ipcMain.handle('mods:search', (_e, opts: { query: string; mcVersion: string; loader: string; offset?: number; limit?: number; sort?: string }) =>
    searchMods(opts),
  );
  ipcMain.handle('mods:versions', (_e, idOrSlug: string, mcVersion: string, loader: string) =>
    listModVersions(idOrSlug, mcVersion, loader),
  );
  ipcMain.handle('mods:install', async (_e, opts: { idOrSlug: string; versionId?: string; mcVersion: string; loader: string }) => {
    if (downloadRunning) return { ok: false, error: '已有下载任务进行中', fileName: '', dependencies: 0 };
    downloadRunning = true;
    downloadAbort = false;
    try {
      const res = await installMod(opts);
      pushDownloadEnd(res.ok, [], res.error);
      return res;
    } finally {
      downloadRunning = false;
    }
  });
  ipcMain.handle('mods:updates', (_e, mcVersion: string, loader: string) => checkModUpdates(mcVersion, loader));
  ipcMain.handle('mods:update', (_e, oldFileName: string, file: import('./types').ModFile) =>
    applyModUpdate(oldFileName, file),
  );
  ipcMain.handle('shell:reveal', (_e, target: string) => {
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) void shell.openPath(target);
      else shell.showItemInFolder(target);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('mods:list', () => listInstalledMods());
  ipcMain.handle('mods:toggle', (_e, fileName: string, enabled: boolean) => setModEnabled(fileName, enabled));
  ipcMain.handle('mods:delete', (_e, fileName: string) => deleteMod(fileName));

  ipcMain.handle('servers:index', async () => fetchServerIndex());

  ipcMain.handle('java:scan', async () => scanJava());

  ipcMain.handle('download:start', (_e, versionId: string) => downloadVersion(versionId));
  ipcMain.handle('download:cancel', () => {
    downloadAbort = true;
  });

  ipcMain.handle('download:active', () => downloadRunning);

  ipcMain.handle('launch:start', (_e, opts: LaunchOptions) => launchFlow(opts));
  ipcMain.handle('launch:stop', () => stopGame());

  // 服务器核心文件下载（仅 1B1T 源直链；targetPath 为空时先弹保存对话框）
  ipcMain.handle('core:download', async (_e, url: string, targetPath: string, sha1: string) => {
    if (!url.startsWith(getServerSource().baseUrl.replace(/\/+$/, '')) && !url.startsWith('https://www.1b1t.cn')) {
      return { ok: false, error: '服务器核心文件仅允许从 1B1T mirror 下载' };
    }
    let target = targetPath;
    if (!target) {
      const win = BrowserWindow.getAllWindows()[0];
      const suggest = url.split('/').pop() || 'server-core.jar';
      const r = await dialog.showSaveDialog(win, {
        title: '保存服务器核心文件',
        defaultPath: path.join(resolveGameDir(), 'server-cores', suggest),
      });
      if (r.canceled || !r.filePath) return { ok: false, error: '已取消' };
      target = r.filePath;
    }
    if (downloadRunning) return { ok: false, error: '已有下载任务进行中' };
    downloadRunning = true;
    downloadAbort = false;
    try {
      const file: ResourceFile = {
        key: 'core:single',
        name: path.basename(target),
        path: target,
        candidates: [{ sourceId: '1b1t-server', url }],
        sha1,
        size: 0,
      };
      const res = await runDownloads([file], {
        onProgress: (task, doneCount, totalCount) => pushDownload(task, doneCount, totalCount),
        shouldAbort: () => downloadAbort,
      });
      if (res.failed.length > 0) {
        const error = failSummary(res.failed);
        pushDownloadEnd(false, res.failed, error);
        return { ok: false, error };
      }
      pushDownloadEnd(true, [], '');
      return { ok: true, error: '' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      downloadRunning = false;
    }
  });

  // ---- 自定义壁纸：选择本地图片并复制到用户数据目录 ----
  ipcMain.handle('wallpaper:pick', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, {
      title: '选择背景壁纸',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'],
    });
    if (r.canceled || r.filePaths.length === 0) return '';
    const src = r.filePaths[0];
    const ext = path.extname(src).toLowerCase() || '.png';
    const dir = path.join(app.getPath('userData'), 'wallpaper');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `wallpaper-${Date.now()}${ext}`);
    fs.copyFileSync(src, dest);
    return dest;
  });

  // ---- 语言包（外置 locales 目录，新增文件即新增语言，免重编译）----
  const localesDir = (() => {
    const app = require('electron').app;
    if (app.isPackaged) return path.join(process.resourcesPath, 'locales');
    return path.join(__dirname, '..', 'locales');
  })();
  ipcMain.handle('lang:list', () => {
    const dir = localesDir;
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const id = f.replace(/\.json$/, '');
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Record<string, string>;
            return { id, label: meta._label ?? id };
          } catch {
            return { id, label: id };
          }
        });
    } catch {
      return [];
    }
  });
  ipcMain.handle('lang:load', (_e, id: string) => {
    const dir = localesDir;
    try {
      const raw = fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8');
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  });
  ipcMain.handle('lang:system', () => {
    const l = (process.env.LANG ?? '').toLowerCase();
    if (l.startsWith('zh_tw') || l.startsWith('zh-tw') || l.startsWith('zh_hk')) return 'zh-TW';
    if (l.startsWith('zh')) return 'zh-CN';
    if (l.startsWith('en')) return 'en-US';
    return 'en-US';
  });
}
