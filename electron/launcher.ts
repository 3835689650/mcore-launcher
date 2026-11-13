// 游戏启动：离线账号、参数生成（version.json 原样拼装）、spawn 与日志转发
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { applyRules, flattenArguments, libraryPathFromName, osName, type ParsedVersion } from './versions';
import { extractZip } from './zip';
import type { LaunchLog, LaunchOptions } from './types';

const LAUNCHER_NAME = 'MCore Launcher';
const LAUNCHER_VERSION = '1.0.0';

/** 离线 UUID：MD5("OfflinePlayer:" + name) 按 Java UUID v3 规范派生 */
export function offlineUuid(username: string): string {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf-8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // variant
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 校验离线用户名：3-16 位，仅字母/数字/下划线 */
export function validateOfflineUsername(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
    return '用户名需为 3-16 位字母、数字或下划线';
  }
  return '';
}

/** 收集 classpath：全部通过规则的 library + natives classifier + client jar */
function buildClasspath(json: ParsedVersion, gameDir: string): string[] {
  const cp: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      cp.push(p);
    }
  };
  const libDir = path.join(gameDir, 'libraries');
  for (const lib of json.libraries ?? []) {
    if (!applyRules(lib.rules)) continue;
    const artifact = lib.downloads?.artifact;
    // 加载器追加的库只有 name（无 downloads），按 maven 坐标推导路径
    const rel = artifact?.path ?? libraryPathFromName(lib.name);
    if (rel) {
      const p = path.join(libDir, rel);
      if (fs.existsSync(p)) push(p);
    }
    // natives classifier
    const cls = lib.natives?.[osName()];
    if (cls) {
      const info = lib.downloads?.classifiers?.[cls];
      if (info?.path) {
        const p = path.join(libDir, info.path);
        if (fs.existsSync(p)) push(p);
      }
    }
  }
  const jarId = json.jarId ?? json.id;
  // Forge/NeoForge（bootstraplauncher）由安装器生成 patch 后的 client jar，
  // 原版 jar 不能再进 classpath，否则 minecraft 模块与 patched 模块会包冲突
  const skipVanillaJar = /bootstraplauncher/i.test(json.mainClass ?? '');
  if (!skipVanillaJar) {
    const clientJar = path.join(gameDir, 'versions', jarId, `${jarId}.jar`);
    if (fs.existsSync(clientJar)) push(clientJar);
  }
  return cp;
}

/** 解压 natives jar 到版本 natives 目录（已解压且签名一致时跳过，减少每次启动耗时） */
function extractNatives(json: ParsedVersion, gameDir: string): string {
  const nativesDir = path.join(gameDir, 'versions', json.id, 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });
  const libDir = path.join(gameDir, 'libraries');
  const sigParts: string[] = [];
  for (const lib of json.libraries ?? []) {
    if (!applyRules(lib.rules)) continue;
    const cls = lib.natives?.[osName()];
    if (!cls) continue;
    const info = lib.downloads?.classifiers?.[cls];
    if (info?.path) sigParts.push(info.path);
  }
  const sig = sigParts.join('|');
  const marker = path.join(nativesDir, '.mcore-extract');
  try {
    if (fs.readFileSync(marker, 'utf-8') === sig) return nativesDir;
  } catch {
    // 首次解压
  }
  for (const lib of json.libraries ?? []) {
    if (!applyRules(lib.rules)) continue;
    const cls = lib.natives?.[osName()];
    if (!cls) continue;
    const info = lib.downloads?.classifiers?.[cls];
    if (!info?.path) continue;
    const jarPath = path.join(libDir, info.path);
    if (!fs.existsSync(jarPath)) continue;
    const exclude = lib.extract?.exclude ?? [];
    try {
      extractZip(jarPath, nativesDir, exclude);
    } catch {
      // 解压失败不阻塞启动（lwjgl 可从 classpath 自行提取）
    }
  }
  try {
    fs.writeFileSync(marker, sig, 'utf-8');
  } catch {
    // 忽略
  }
  return nativesDir;
}

/** 替换参数中的启动器变量 */
function replaceVars(
  arg: string,
  vars: Record<string, string>,
  classpath: string,
  classpathSep: string,
): string {
  let out = arg;
  out = out.replace(/\$\{classpath\}/g, classpath);
  out = out.replace(/\$\{classpath_separator\}/g, classpathSep);
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), v);
  }
  return out;
}

/**
 * 生成启动参数。
 * 新格式（arguments 字段）原样拼装并替换变量；
 * 老格式（minecraftArguments）合成 JVM 参数（-Djava.library.path / -cp / mainClass）+ 拆分的 game 参数
 */
export function buildLaunchArgs(
  json: ParsedVersion,
  opts: LaunchOptions,
): string[] {
  const gameDir = opts.gameDir;
  const nativesDir = path.join(gameDir, 'versions', json.id, 'natives');
  const classpathSep = process.platform === 'win32' ? ';' : ':';
  const classpath = buildClasspath(json, gameDir).join(classpathSep);

  const vars: Record<string, string> = {
    auth_player_name: opts.username,
    auth_uuid: offlineUuid(opts.username),
    auth_access_token: offlineUuid(opts.username),
    user_type: 'legacy',
    user_properties: '{}',
    // 离线登录无正版凭据：这些变量在 1.20.5+ 的 arguments 里出现，必须替换为空
    clientid: '',
    auth_xuid: '',
    auth_session: '',
    version_name: json.id,
    version_type: json.type,
    game_directory: gameDir,
    assets_root: path.join(gameDir, 'assets'),
    assets_index_name: json.assetIndex?.id ?? json.assets ?? '',
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    library_directory: path.join(gameDir, 'libraries'),
    resolution_width: '854',
    resolution_height: '480',
    quickPlayMultiplayer: `${opts.serverAddress}:${opts.serverPort}`,
    quickPlaySingleplayer: '',
    quickPlayPath: '',
    quickPlayRealms: '',
  };

  const jvmArgs: string[] = [];
  const gameArgs: string[] = [];
  let mainIdx = -1;

  if (json.arguments) {
    for (const a of flattenArguments(json.arguments.jvm)) {
      jvmArgs.push(replaceVars(a, vars, classpath, classpathSep));
    }
    for (const a of flattenArguments(json.arguments.game)) {
      gameArgs.push(replaceVars(a, vars, classpath, classpathSep));
    }
    // 新格式 json 不含 mainClass 参数，由启动器在 -cp 后追加
    if (json.mainClass) {
      mainIdx = jvmArgs.length;
      jvmArgs.push(json.mainClass);
    }
  } else if (json.minecraftArguments) {
    // 老格式：合成 JVM 参数
    jvmArgs.push(`-Djava.library.path=${nativesDir}`);
    jvmArgs.push('-cp', classpath);
    if (json.mainClass) {
      mainIdx = jvmArgs.length;
      jvmArgs.push(json.mainClass);
    }
    gameArgs.push(...json.minecraftArguments.split(' ').filter((s) => s.length > 0));
    for (let i = 0; i < gameArgs.length; i += 1) {
      gameArgs[i] = replaceVars(gameArgs[i], vars, classpath, classpathSep);
    }
  }

  // 内存设置：替换已有 -Xmx，否则插到主类之前（放到主类后会被游戏当成参数忽略）
  const memFlag = `-Xmx${opts.memoryGB}G`;
  const xmxIdx = jvmArgs.findIndex((a) => a.startsWith('-Xmx'));
  if (xmxIdx >= 0) jvmArgs[xmxIdx] = memFlag;
  else if (mainIdx >= 0) jvmArgs.splice(mainIdx, 0, memFlag);
  else jvmArgs.push(memFlag);

  // 直连服务器（经典 --server/--port，全版本可用）
  if (opts.serverAddress) {
    gameArgs.push('--server', opts.serverAddress, '--port', String(opts.serverPort));
  }

  // 1.21+ 用 -cp 形态（jvm 参数中已含 -cp 与 mainClass）
  return [...jvmArgs, ...gameArgs];
}

let gameProcess: ChildProcess | null = null;
let stopRequested = false;

/** 读取并清除“用户主动停止”标记（避免正常停止被当成崩溃） */
export function consumeStopRequest(): boolean {
  const v = stopRequested;
  stopRequested = false;
  return v;
}

/** 启动游戏，日志通过回调推送 */
export function launchGame(
  javaPath: string,
  args: string[],
  gameDir: string,
  onLog: (log: LaunchLog) => void,
  onExit: (code: number | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (gameProcess) {
      reject(new Error('游戏已在运行'));
      return;
    }
    try {
      const child = spawn(javaPath, args, { cwd: gameDir, stdio: ['ignore', 'pipe', 'pipe'] });
      gameProcess = child;
      let started = false;
      child.once('spawn', () => {
        started = true;
        resolve();
      });
      child.stdout.on('data', (d: Buffer) => onLog({ line: d.toString('utf-8'), stream: 'stdout' }));
      child.stderr.on('data', (d: Buffer) => onLog({ line: d.toString('utf-8'), stream: 'stderr' }));
      child.on('error', (e) => {
        gameProcess = null;
        if (!started) reject(e);
        else onExit(null); // 运行期异常：通知界面复位「游戏中」状态
      });
      child.on('exit', (code) => {
        gameProcess = null;
        onExit(code);
      });
    } catch (e) {
      gameProcess = null;
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** 停止游戏进程 */
export function stopGame(): void {
  if (gameProcess) {
    stopRequested = true;
    try {
      gameProcess.kill();
    } catch {
      // 已退出
    }
    gameProcess = null;
  }
}

/** 游戏是否在运行 */
export function isGameRunning(): boolean {
  return gameProcess !== null;
}

export { extractNatives };
