// 全局应用状态：设置、下载任务、启动日志、游戏运行态
import * as React from 'react';
import type {
  DownloadProgress,
  DownloadTask,
  JavaRuntime,
  LaunchCrash,
  LaunchLog,
  Settings,
  SourceTestResult,
  VersionManifestEntry,
} from '../../electron/types';

interface AppState {
  settings: Settings | null;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  /** 下载任务（key → task） */
  downloads: Map<string, DownloadTask>;
  downloadDone: number;
  downloadTotal: number;
  downloading: boolean;
  /** 启动日志 */
  logs: LaunchLog[];
  clearLogs: () => void;
  gameRunning: boolean;
  setGameRunning: (v: boolean) => void;
  /** 最近一次启动崩溃信息 */
  crash: LaunchCrash | null;
  clearCrash: () => void;
  /** 各页面共享缓存 */
  versions: VersionManifestEntry[];
  setVersions: (v: VersionManifestEntry[]) => void;
  javaList: JavaRuntime[];
  setJavaList: (v: JavaRuntime[]) => void;
  sourceResults: SourceTestResult[];
  setSourceResults: (v: SourceTestResult[]) => void;
}

const AppContext = React.createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [downloads, setDownloads] = React.useState<Map<string, DownloadTask>>(new Map());
  const [downloadDone, setDownloadDone] = React.useState(0);
  const [downloadTotal, setDownloadTotal] = React.useState(0);
  const [downloading, setDownloading] = React.useState(false);
  const [logs, setLogs] = React.useState<LaunchLog[]>([]);
  const [gameRunning, setGameRunning] = React.useState(false);
  const [crash, setCrash] = React.useState<LaunchCrash | null>(null);
  const [versions, setVersions] = React.useState<VersionManifestEntry[]>([]);
  const [javaList, setJavaList] = React.useState<JavaRuntime[]>([]);
  const [sourceResults, setSourceResults] = React.useState<SourceTestResult[]>([]);

  // 设置加载
  React.useEffect(() => {
    let alive = true;
    window.mcore.getSettings().then((s) => {
      if (alive) setSettings(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 主题应用
  React.useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const apply = (mode: 'light' | 'dark') => {
      root.setAttribute('data-theme', mode);
    };
    if (settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const onChange = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    apply(settings.theme);
    return undefined;
  }, [settings?.theme]);

  // 下载进度订阅
  React.useEffect(() => {
    const off = window.mcore.onDownloadProgress((p: DownloadProgress) => {
      setDownloading(true);
      setDownloads((prev) => {
        const next = new Map(prev);
        next.set(p.task.key, p.task);
        return next;
      });
      setDownloadDone(p.doneCount);
      setDownloadTotal(p.totalCount);
      if (p.doneCount >= p.totalCount && p.task.status === 'done') {
        setDownloading(false);
      }
    });
    // 主进程明确通知结束（成功/失败/取消），修复失败时永远停在「下载中」
    const offEnd = window.mcore.onDownloadEnd(() => {
      setDownloading(false);
    });
    return () => {
      off();
      offEnd();
    };
  }, []);

  // 启动日志订阅
  React.useEffect(() => {
    const offLog = window.mcore.onLaunchLog((log: LaunchLog) => {
      setLogs((prev) => (prev.length > 2000 ? [...prev.slice(-1000), log] : [...prev, log]));
    });
    const offExit = window.mcore.onLaunchExit(() => {
      setGameRunning(false);
    });
    const offCrash = window.mcore.onLaunchCrash((info) => {
      setCrash(info);
      setGameRunning(false);
    });
    return () => {
      offLog();
      offExit();
      offCrash();
    };
  }, []);

  const updateSettings = React.useCallback(
    async (patch: Partial<Settings>) => {
      const s = await window.mcore.setSettings(patch);
      setSettings(s);
    },
    [],
  );

  const clearLogs = React.useCallback(() => setLogs([]), []);
  const clearCrash = React.useCallback(() => setCrash(null), []);

  const value = React.useMemo<AppState>(
    () => ({
      settings,
      updateSettings,
      downloads,
      downloadDone,
      downloadTotal,
      downloading,
      logs,
      clearLogs,
      gameRunning,
      setGameRunning,
      crash,
      clearCrash,
      versions,
      setVersions,
      javaList,
      setJavaList,
      sourceResults,
      setSourceResults,
    }),
    [settings, updateSettings, downloads, downloadDone, downloadTotal, downloading, logs, clearLogs, gameRunning, crash, clearCrash, versions, javaList, sourceResults],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
