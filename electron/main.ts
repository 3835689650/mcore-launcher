// MCore Launcher 主进程入口：窗口、托盘、关闭行为、生命周期
import { app, BrowserWindow, dialog, Menu, nativeImage, net, protocol, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getSettings, setSettings } from './config';
import { registerIpc } from './ipc';
import { isGameRunning, stopGame } from './launcher';

// 自定义壁纸协议：渲染进程经此读取用户选择的本地图片（dev/prod 均可用）
protocol.registerSchemesAsPrivileged([
  { scheme: 'mcore-wallpaper', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// 启动画面：最长显示时间、最短展示时间（避免闪一下就没）
const SPLASH_START = Date.now();
const SPLASH_MIN_MS = 2000;
const SPLASH_MAX_MS = 6000;

// 启动耗时诊断：MCORE_DEBUG=1 时输出各阶段时间戳
const T0 = Date.now();
function mark(label: string): void {
  if (process.env.MCORE_DEBUG) console.log(`[startup] ${label} +${Date.now() - T0}ms`);
}
mark('main-module-loaded');

const DEV_URL = process.env.MCORE_DEV_URL ?? 'http://localhost:5173';

// 启动画面窗口：无边框、透明圆角，先于主窗口出现
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 460,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    title: 'MCore Launcher',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.show();
  });
  splash.webContents.on('did-fail-load', () => closeSplash());
  return splash;
}

// 淡出并销毁启动画面；重复调用安全
function closeSplash(): void {
  const splash = splashWindow;
  if (!splash) return;
  splashWindow = null;
  try {
    splash.webContents.executeJavaScript("document.body.classList.add('out')").catch(() => undefined);
  } catch {
    // 渲染进程已退出时忽略
  }
  setTimeout(() => {
    if (!splash.isDestroyed()) splash.destroy();
  }, 260);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    minWidth: 960,
    minHeight: 640,
    title: 'MCore Launcher',
    backgroundColor: '#18181B',
    autoHideMenuBar: true,
    icon: path.join(process.resourcesPath, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.on('dom-ready', () => mark('dom-ready'));
  win.webContents.on('did-finish-load', () => {
    mark('did-finish-load');
    win.webContents
      .executeJavaScript('Math.round(performance.now())')
      .then((ms) => mark(`renderer-boot-internal ${ms}ms`))
      .catch(() => undefined);
  });

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    win.loadURL(DEV_URL);
  }

  // 关闭行为：ask=弹窗询问（可记住选择） exit=直接退出 tray=最小化托盘
  win.on('close', (e) => {
    if (quitting) return;
    const action = getSettings().closeAction;
    if (action === 'exit') return;
    if (action === 'tray') {
      e.preventDefault();
      win.hide();
      return;
    }
    // ask
    e.preventDefault();
    dialog
      .showMessageBox(win, {
        type: 'question',
        title: 'MCore Launcher',
        message: '关闭 MCore Launcher？',
        detail: isGameRunning() ? '游戏进程仍在运行，退出启动器不会关闭游戏。' : '',
        buttons: ['退出程序', '最小化到托盘'],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: '记住我的选择',
        checkboxChecked: false,
        noLink: true,
      })
      .then((r) => {
        if (r.checkboxChecked) {
          setSettings({ closeAction: r.response === 0 ? 'exit' : 'tray' });
        }
        if (r.response === 0) {
          quitting = true;
          stopGame();
          app.quit();
        } else {
          win.hide();
        }
      })
      .catch(() => {
        // 用户直接关掉了弹窗 → 保持运行
      });
  });

  // 主窗口就绪后接管启动画面：满足最短展示时间再显示，失败/超时也保证能看到窗口
  let revealed = false;
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - SPLASH_START));
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      closeSplash();
      mark('window-revealed');
    }, wait);
  };
  win.once('ready-to-show', reveal);
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    mark(`load-failed ${code} ${desc}`);
    reveal();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) reveal();
  }, SPLASH_MAX_MS);

  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

function createTray(): void {
  // 托盘图标：使用应用图标（不存在时用 16x16 纯色占位图）
  const iconPath = path.join(process.resourcesPath, 'icon.png');
  let image: Electron.NativeImage;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error('empty');
    image = image.resize({ width: 16, height: 16 });
  } catch {
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip('MCore Launcher');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        stopGame();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow());
}

function showMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(() => {
  mark('app-ready');
  // 壁纸协议：mcore-wallpaper://local/<encodeURIComponent(绝对路径)>
  protocol.handle('mcore-wallpaper', (request) => {
    try {
      const u = new URL(request.url);
      const p = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!p || !fs.existsSync(p)) return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(p).toString());
    } catch {
      return new Response('', { status: 400 });
    }
  });
  registerIpc();
  mark('ipc-registered');
  try {
    splashWindow = createSplash();
    mark('splash-created');
  } catch {
    splashWindow = null; // 透明窗口不被支持时直接跳过启动画面
  }
  mainWindow = createWindow();
  mark('window-created');
  try {
    createTray();
  } catch {
    // 托盘创建失败不影响主流程（Linux 无托盘环境）
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
  stopGame();
});
