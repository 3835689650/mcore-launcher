// preload：仅通过 contextBridge 暴露白名单 API（沙箱安全）
import { contextBridge, ipcRenderer } from 'electron';
import type {
  CoreFileEntry,
  DownloadEnd,
  DownloadProgress,
  InstalledMod,
  InstalledVersion,
  LaunchCrash,
  ModFile,
  ModHit,
  ModUpdate,
  ModVersionInfo,
  JavaRuntime,
  LaunchLog,
  LaunchOptions,
  LoaderVersions,
  MCoreApi,
  MirrorsConfig,
  ServerIndex,
  Settings,
  SourceTestResult,
  VersionManifestEntry,
} from './types';

const api: MCoreApi = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
  getMirrors: () => ipcRenderer.invoke('mirrors:get') as Promise<MirrorsConfig>,
  testSources: () => ipcRenderer.invoke('sources:test') as Promise<SourceTestResult[]>,
  listVersions: () => ipcRenderer.invoke('versions:list') as Promise<VersionManifestEntry[]>,
  listInstalledVersions: () => ipcRenderer.invoke('versions:installed') as Promise<InstalledVersion[]>,
  listLoaders: (mcVersion) => ipcRenderer.invoke('loaders:list', mcVersion) as Promise<LoaderVersions[]>,
  installVersion: (versionId, loaderKind, loaderVersion) =>
    ipcRenderer.invoke('version:install', versionId, loaderKind, loaderVersion) as Promise<{ ok: boolean; error: string; versionId: string }>,
  isVersionReady: (versionId) => ipcRenderer.invoke('versions:ready', versionId) as Promise<{ ready: boolean }>,
  deleteVersion: (versionId) => ipcRenderer.invoke('versions:delete', versionId) as Promise<{ ok: boolean; error: string }>,
  getServerIndex: () => ipcRenderer.invoke('servers:index') as Promise<ServerIndex>,
  searchMods: (opts) => ipcRenderer.invoke('mods:search', opts) as Promise<{ hits: ModHit[]; total: number }>,
  listModVersions: (idOrSlug, mcVersion, loader) =>
    ipcRenderer.invoke('mods:versions', idOrSlug, mcVersion, loader) as Promise<ModVersionInfo[]>,
  installMod: (opts) =>
    ipcRenderer.invoke('mods:install', opts) as Promise<{ ok: boolean; error: string; fileName: string; dependencies: number }>,
  listInstalledMods: () => ipcRenderer.invoke('mods:list') as Promise<InstalledMod[]>,
  setModEnabled: (fileName, enabled) =>
    ipcRenderer.invoke('mods:toggle', fileName, enabled) as Promise<{ ok: boolean; error: string }>,
  deleteMod: (fileName) => ipcRenderer.invoke('mods:delete', fileName) as Promise<{ ok: boolean; error: string }>,
  checkModUpdates: (mcVersion, loader) =>
    ipcRenderer.invoke('mods:updates', mcVersion, loader) as Promise<{
      updates: ModUpdate[];
      checked: number;
      unknown: number;
    }>,
  applyModUpdate: (oldFileName, file) =>
    ipcRenderer.invoke('mods:update', oldFileName, file) as Promise<{ ok: boolean; error: string; newFileName: string }>,
  revealPath: (target) => ipcRenderer.invoke('shell:reveal', target) as Promise<boolean>,
  scanJava: () => ipcRenderer.invoke('java:scan') as Promise<JavaRuntime[]>,
  startDownload: (versionId) => ipcRenderer.invoke('download:start', versionId) as Promise<{ ok: boolean; error: string }>,
  cancelDownload: () => ipcRenderer.invoke('download:cancel') as Promise<void>,
  onDownloadProgress: (cb) => {
    const listener = (_e: unknown, p: DownloadProgress) => cb(p);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onDownloadEnd: (cb) => {
    const listener = (_e: unknown, p: DownloadEnd) => cb(p);
    ipcRenderer.on('download-end', listener);
    return () => ipcRenderer.removeListener('download-end', listener);
  },
  launch: (opts: LaunchOptions) => ipcRenderer.invoke('launch:start', opts) as Promise<{ ok: boolean; error: string }>,
  stopLaunch: () => ipcRenderer.invoke('launch:stop') as Promise<void>,
  onLaunchLog: (cb) => {
    const listener = (_e: unknown, log: LaunchLog) => cb(log);
    ipcRenderer.on('launch-log', listener);
    return () => ipcRenderer.removeListener('launch-log', listener);
  },
  onLaunchExit: (cb) => {
    const listener = (_e: unknown, code: number | null) => cb(code);
    ipcRenderer.on('launch-exit', listener);
    return () => ipcRenderer.removeListener('launch-exit', listener);
  },
  onLaunchCrash: (cb) => {
    const listener = (_e: unknown, info: LaunchCrash) => cb(info);
    ipcRenderer.on('launch-crash', listener);
    return () => ipcRenderer.removeListener('launch-crash', listener);
  },
  downloadCoreFile: (entry: CoreFileEntry, targetPath: string) =>
    ipcRenderer.invoke('core:download', entry.url, targetPath, entry.sha1 ?? '') as Promise<{ ok: boolean; error: string }>,
  getLanguages: () => ipcRenderer.invoke('lang:list') as Promise<{ id: string; label: string }[]>,
  loadLanguage: (id) => ipcRenderer.invoke('lang:load', id) as Promise<Record<string, string>>,
  resolveSystemLanguage: () => ipcRenderer.invoke('lang:system') as Promise<string>,
  getAppInfo: () => ipcRenderer.invoke('app:info') as Promise<{ version: string; gameDir: string }>,
  pickWallpaper: () => ipcRenderer.invoke('wallpaper:pick') as Promise<string>,
  checkUpdate: () =>
    ipcRenderer.invoke('update:check') as Promise<{ hasUpdate: boolean; latest: string; note: string; url: string }>,
  applyUpdate: () =>
    ipcRenderer.invoke('update:apply') as Promise<{ ok: boolean; error: string; needRestart: boolean }>,
  onUpdateProgress: (cb) => {
    const listener = (_e: unknown, p: { received: number; total: number; latest: string }) => cb(p);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  },
};

contextBridge.exposeInMainWorld('mcore', api);
