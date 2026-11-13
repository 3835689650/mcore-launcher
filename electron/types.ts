// MCore Launcher 主进程共享类型定义
// 渲染进程通过 IPC 获取的数据结构均在此定义

/** 资源源（客户端源 / 服务器源） */
export interface SourceDef {
  id: string;
  name: string;
  /** 源类型：client=客户端资源源 server=服务器文件源 */
  type: 'client' | 'server';
  /** 协议：bmclapi=单一基地址+相对路径 official=Mojang 官方多域名 */
  protocol: 'bmclapi' | 'official';
  baseUrl: string;
  /** 优先级，数值越小越优先（自动模式） */
  priority: number;
  enabled: boolean;
}

/** 镜像源配置文件 mirrors.json 结构 */
export interface MirrorsConfig {
  clientSources: SourceDef[];
  /** 服务器配置文件/核心文件源，仅 1B1T mirror */
  serverSource: SourceDef;
}

/** 主题 */
export type ThemeMode = 'system' | 'light' | 'dark';
/** 语言 */
export type LanguageMode = 'system' | string;
/** 资源源工作模式 */
export type SourceMode = 'auto' | 'manual';
/** 版本列表过滤 */
export type VersionFilter = 'all' | 'release' | 'snapshot' | 'old';
/** 关闭窗口行为 */
export type CloseAction = 'ask' | 'exit' | 'tray';

/** 离线账户 */
export interface AccountEntry {
  name: string;
}

/** 启动器设置 settings.json */
export interface Settings {
  username: string;
  /** 离线账户列表（多账户） */
  accounts: AccountEntry[];
  /** 当前选中账户名，空=未选择 */
  currentAccount: string;
  /** 自定义壁纸文件路径，空=内置默认壁纸 */
  wallpaper: string;
  theme: ThemeMode;
  glassEnabled: boolean;
  /** 玻璃透明度 0-100 */
  glassOpacity: number;
  language: LanguageMode;
  sourceMode: SourceMode;
  /** 手动模式选中的客户端源 id */
  manualSourceId: string;
  /** 内存 GB */
  memoryGB: number;
  /** 手动指定 Java 路径，空=自动探测 */
  javaPath: string;
  /** 游戏目录，空=默认 .minecraft */
  gameDir: string;
  versionFilter: VersionFilter;
  closeAction: CloseAction;
}

/** 下载任务状态 */
export type DownloadStatus = 'pending' | 'downloading' | 'verify' | 'done' | 'failed';

/** 单个文件下载任务 */
export interface DownloadTask {
  /** 任务唯一 key，如 client:1.21.1:jar */
  key: string;
  /** 显示名称 */
  name: string;
  /** 目标文件路径（游戏目录下） */
  path: string;
  /** 下载 URL（由当前源解析出的第一个候选） */
  url: string;
  /** 期望大小（字节），0=未知 */
  size: number;
  /** 期望 SHA1，空=不校验 */
  sha1: string;
  status: DownloadStatus;
  /** 已下载字节 */
  received: number;
  /** 当前使用源 id */
  sourceId: string;
  /** 失败信息 */
  error: string;
}

/** 下载进度推送 */
export interface DownloadProgress {
  task: DownloadTask;
  /** 已完成任务数 */
  doneCount: number;
  /** 总任务数 */
  totalCount: number;
}

/** 探测到的 Java */
export interface JavaRuntime {
  path: string;
  version: string;
  major: number;
  source: string;
}

/** 服务器条目（镜像 servers/index.json） */
export interface ServerEntry {
  id: string;
  name: string;
  address: string;
  port: number;
  desc: string;
}

/** 服务器核心文件条目（镜像 servers/index.json） */
export interface CoreFileEntry {
  name: string;
  url: string;
  size: number;
  sha1: string;
}

/** 服务器索引（镜像 servers/index.json） */
export interface ServerIndex {
  servers: ServerEntry[];
  coreFiles: CoreFileEntry[];
}

/** 模组搜索结果条目（Modrinth） */
export interface ModHit {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  follows: number;
  iconUrl: string;
  categories: string[];
}

/** 模组文件信息 */
export interface ModFile {
  url: string;
  filename: string;
  size: number;
  sha1: string;
}

/** 模组版本（适配某 MC 版本 + 加载器） */
export interface ModVersionInfo {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
  file: ModFile;
  dependencies: { projectId: string; versionId: string; type: string }[];
}

/** 模组更新信息 */
export interface ModUpdate {
  fileName: string;
  projectId: string;
  currentVersionId: string;
  latestVersionId: string;
  latestFileName: string;
  latestUrl: string;
  latestSha1: string;
  latestSize: number;
}

/** 已安装模组 */
export interface InstalledMod {
  fileName: string;
  name: string;
  size: number;
  enabled: boolean;
}

/** 游戏崩溃信息（退出码非 0 时推送） */
export interface LaunchCrash {
  code: number | null;
  summary: string;
  causedBy: string;
  detail: string;
  crashPath: string;
  logPath: string;
  gameDir: string;
}

/** 本地已安装版本（版本目录扫描结果，含加载器改造版） */
export interface InstalledVersion {
  id: string;
  type: string;
  releaseTime: string;
  /** forge / neoforge / fabric / quilt，原版为空 */
  loader: string;
  /** 对应的 MC 版本（加载器版本取 inheritsFrom） */
  mcVersion: string;
}

/** 下载结束通知 */
export interface DownloadEnd {
  ok: boolean;
  /** 失败文件数 */
  failed: number;
  error: string;
}

/** 版本列表条目（version_manifest_v2.json） */
export interface VersionManifestEntry {
  id: string;
  type: string;
  url: string;
  time: string;
  releaseTime: string;
}

/** 资源源连通性测速结果 */
export interface SourceTestResult {
  sourceId: string;
  name: string;
  ok: boolean;
  /** 均速 KB/s */
  speedKBs: number;
  /** 延迟 ms */
  latencyMs: number;
  error: string;
}

/** 模组加载器种类 */
export type LoaderKind = 'forge' | 'neoforge' | 'fabric' | 'quilt';

/** 加载器版本条目 */
export interface LoaderVersion {
  /** 加载器版本号，如 0.19.5 / 52.1.16 / 21.1.220 */
  version: string;
  stable: boolean;
}

/** 加载器版本列表响应 */
export interface LoaderVersions {
  kind: LoaderKind;
  versions: LoaderVersion[];
}

/** 基础 API 选项 */
export interface ApiOption {
  /** 空=无 */
  id: string;
  label: string;
}

/** 启动游戏参数 */
export interface LaunchOptions {
  versionId: string;
  username: string;
  /** Java 路径，空=自动匹配 */
  javaPath: string;
  memoryGB: number;
  /** 游戏目录，空=使用设置值 */
  gameDir: string;
  /** 直连服务器（可选） */
  serverAddress: string;
  serverPort: number;
  /** 模组加载器（可选） */
  loaderKind?: LoaderKind;
  /** 加载器版本（可选） */
  loaderVersion?: string;
  /** 基础 API mod 的 Modrinth 项目 slug（可选：fabric-api / qfapi） */
  apiSlug?: string;
}

/** 启动日志推送 */
export interface LaunchLog {
  line: string;
  stream: 'stdout' | 'stderr' | 'info';
}

/** IPC 暴露给渲染进程的 API 形状（preload） */
export interface MCoreApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  getMirrors(): Promise<MirrorsConfig>;
  testSources(): Promise<SourceTestResult[]>;
  listVersions(): Promise<VersionManifestEntry[]>;
  listInstalledVersions(): Promise<InstalledVersion[]>;
  listLoaders(mcVersion: string): Promise<LoaderVersions[]>;
  installVersion(versionId: string, loaderKind: string, loaderVersion: string): Promise<{ ok: boolean; error: string; versionId: string }>;
  isVersionReady(versionId: string): Promise<{ ready: boolean }>;
  deleteVersion(versionId: string): Promise<{ ok: boolean; error: string }>;
  getServerIndex(): Promise<ServerIndex>;
  searchMods(opts: {
    query: string;
    mcVersion: string;
    loader: string;
    offset?: number;
    limit?: number;
    sort?: string;
  }): Promise<{ hits: ModHit[]; total: number }>;
  listModVersions(idOrSlug: string, mcVersion: string, loader: string): Promise<ModVersionInfo[]>;
  installMod(opts: {
    idOrSlug: string;
    versionId?: string;
    mcVersion: string;
    loader: string;
  }): Promise<{ ok: boolean; error: string; fileName: string; dependencies: number }>;
  listInstalledMods(): Promise<InstalledMod[]>;
  setModEnabled(fileName: string, enabled: boolean): Promise<{ ok: boolean; error: string }>;
  deleteMod(fileName: string): Promise<{ ok: boolean; error: string }>;
  checkModUpdates(mcVersion: string, loader: string): Promise<{ updates: ModUpdate[]; checked: number; unknown: number }>;
  applyModUpdate(oldFileName: string, file: ModFile): Promise<{ ok: boolean; error: string; newFileName: string }>;
  revealPath(target: string): Promise<boolean>;
  scanJava(): Promise<JavaRuntime[]>;
  startDownload(versionId: string): Promise<{ ok: boolean; error: string }>;
  cancelDownload(): Promise<void>;
  onDownloadProgress(cb: (p: DownloadProgress) => void): () => void;
  onDownloadEnd(cb: (p: DownloadEnd) => void): () => void;
  launch(opts: LaunchOptions): Promise<{ ok: boolean; error: string }>;
  stopLaunch(): Promise<void>;
  onLaunchLog(cb: (log: LaunchLog) => void): () => void;
  onLaunchExit(cb: (code: number | null) => void): () => void;
  onLaunchCrash(cb: (info: LaunchCrash) => void): () => void;
  downloadCoreFile(entry: CoreFileEntry, targetPath: string): Promise<{ ok: boolean; error: string }>;
  getLanguages(): Promise<{ id: string; label: string }[]>;
  loadLanguage(id: string): Promise<Record<string, string>>;
  resolveSystemLanguage(): Promise<string>;
  getAppInfo(): Promise<{ version: string; gameDir: string }>;
  pickWallpaper(): Promise<string>;
  checkUpdate(): Promise<{ hasUpdate: boolean; latest: string; note: string; url: string }>;
  applyUpdate(): Promise<{ ok: boolean; error: string; needRestart: boolean; manual?: boolean }>;
  onUpdateProgress(cb: (p: { received: number; total: number; latest: string }) => void): () => void;
}

declare global {
  interface Window {
    mcore: MCoreApi;
  }
}
