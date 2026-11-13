// 配置读写：settings.json（用户设置）+ mirrors.json（资源源列表）
// 两个文件均在 userData 目录，mirrors.json 首次启动自动生成默认值，用户可手工新增资源源
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { MirrorsConfig, Settings } from './types';

/** 默认设置 */
const DEFAULT_SETTINGS: Settings = {
  username: '',
  accounts: [],
  currentAccount: '',
  wallpaper: '',
  theme: 'dark',
  glassEnabled: true,
  glassOpacity: 70,
  language: 'system',
  sourceMode: 'auto',
  manualSourceId: '1b1t',
  memoryGB: 2,
  javaPath: '',
  gameDir: '',
  versionFilter: 'all',
  closeAction: 'ask',
};

/** 默认资源源：客户端三级 + 服务器源（1B1T 专用） */
function defaultMirrors(): MirrorsConfig {
  return {
    clientSources: [
      {
        id: '1b1t',
        name: '1B1T mirror',
        type: 'client',
        protocol: 'bmclapi',
        baseUrl: 'https://mcdown.cn-nb1.rains3.com/bmclapi2.bangbang93.com',
        priority: 1,
        enabled: true,
      },
      {
        id: 'bmclapi',
        name: 'BMCLAPI 国内镜像',
        type: 'client',
        protocol: 'bmclapi',
        baseUrl: 'https://bmclapi2.bangbang93.com',
        priority: 2,
        enabled: true,
      },
      {
        id: 'mojang',
        name: 'Mojang 官方源',
        type: 'client',
        protocol: 'official',
        baseUrl: 'https://piston-meta.mojang.com',
        priority: 3,
        enabled: true,
      },
    ],
    serverSource: {
      id: '1b1t-server',
      name: '1B1T mirror 服务器源',
      type: 'server',
      protocol: 'bmclapi',
      baseUrl: 'https://www.1b1t.cn/serverdown',
      priority: 1,
      enabled: true,
    },
  };
}

let cacheSettings: Settings | null = null;
let cacheMirrors: MirrorsConfig | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function mirrorsPath(): string {
  return path.join(app.getPath('userData'), 'mirrors.json');
}

/** 读取设置，文件缺失/损坏时回退默认值；旧配置自动迁移（username → accounts） */
export function getSettings(): Settings {
  if (cacheSettings) return cacheSettings;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    cacheSettings = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    cacheSettings = { ...DEFAULT_SETTINGS };
  }
  // 旧版单用户名迁移为多账户
  if (!Array.isArray(cacheSettings.accounts)) cacheSettings.accounts = [];
  if (cacheSettings.accounts.length === 0 && cacheSettings.username && cacheSettings.username.trim()) {
    cacheSettings.accounts = [{ name: cacheSettings.username.trim() }];
    cacheSettings.currentAccount = cacheSettings.username.trim();
  }
  return cacheSettings;
}

/** 合并写入设置并写盘 */
export function setSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings();
  cacheSettings = { ...cur, ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(cacheSettings, null, 2), 'utf-8');
  } catch {
    // 写盘失败不影响本次会话，内存值仍生效
  }
  return cacheSettings;
}

/** 读取资源源配置；文件不存在时生成默认并写盘，方便用户后续手工编辑新增源 */
export function getMirrors(): MirrorsConfig {
  if (cacheMirrors) return cacheMirrors;
  const p = mirrorsPath();
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as MirrorsConfig;
    if (parsed && Array.isArray(parsed.clientSources) && parsed.serverSource) {
      cacheMirrors = parsed;
      return parsed;
    }
  } catch {
    // 不存在或损坏 → 重新生成默认
  }
  cacheMirrors = defaultMirrors();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cacheMirrors, null, 2), 'utf-8');
  } catch {
    // 忽略写盘失败
  }
  return cacheMirrors;
}

/** 游戏目录：设置为空时用标准 .minecraft */
export function resolveGameDir(): string {
  const s = getSettings();
  if (s.gameDir && s.gameDir.trim()) return s.gameDir;
  return path.join(app.getPath('home'), '.minecraft');
}
