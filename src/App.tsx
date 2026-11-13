// MCore Launcher 渲染进程入口
import * as React from 'react';
import { AppShell, type PageId } from './components/AppShell';
import { AppProvider, useApp } from './lib/store';
import { I18nProvider, useI18n } from './lib/i18n';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './components/ui/dialog';
import { HomePage } from './pages/HomePage';

// 非首屏页面按需加载，减小启动时解析的 JS 体积（启动提速）
const VersionsPage = React.lazy(() =>
  import('./pages/VersionsPage').then((m) => ({ default: m.VersionsPage })),
);
const DownloadPage = React.lazy(() =>
  import('./pages/DownloadPage').then((m) => ({ default: m.DownloadPage })),
);
const ModsPage = React.lazy(() => import('./pages/ModsPage').then((m) => ({ default: m.ModsPage })));
const SettingsPage = React.lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

function AppInner(): React.JSX.Element {
  const [page, setPage] = React.useState<PageId>('home');
  const [selectedVersion, setSelectedVersion] = React.useState('');
  const [update, setUpdate] = React.useState<{ latest: string; note: string; url: string } | null>(null);
  const [updating, setUpdating] = React.useState(false);
  const [updatePct, setUpdatePct] = React.useState(0);
  const { versions, downloading, crash, clearCrash } = useApp();
  const { t } = useI18n();
  const prevDownloading = React.useRef(false);

  // 自动更新：下载进度订阅
  React.useEffect(() => {
    return window.mcore.onUpdateProgress((p) => {
      if (p.total > 0) setUpdatePct(Math.round((p.received / p.total) * 100));
    });
  }, []);

  const doApplyUpdate = async () => {
    setUpdating(true);
    try {
      const r = await window.mcore.applyUpdate();
      if (r.ok && (r as { upToDate?: boolean }).upToDate) {
        setUpdate(null);
        window.alert('已是最新版本');
      } else if (r.ok && r.manual) {
        setUpdate(null);
        window.alert('更新包已下载到「下载」文件夹，请退出启动器后解压替换应用');
      } else if (r.ok && r.needRestart) {
        setUpdate(null);
        window.alert('更新完成，请重启启动器生效');
      } else if (!r.ok) {
        window.alert(`更新失败：${r.error}`);
      }
    } finally {
      setUpdating(false);
      setUpdatePct(0);
    }
  };

  // 默认选中第一个正式版
  React.useEffect(() => {
    if (!selectedVersion && versions.length > 0) {
      const first = versions.find((v) => v.type === 'release') ?? versions[0];
      if (first) setSelectedVersion(first.id);
    }
  }, [versions, selectedVersion]);

  // 更新检测：启动检测 + 后台每 30 分钟静默检测
  React.useEffect(() => {
    const check = () => {
      window.mcore
        .checkUpdate()
        .then((r) => {
          if (r.hasUpdate && r.latest) setUpdate({ latest: r.latest, note: r.note, url: r.url });
        })
        .catch(() => undefined);
    };
    // 延后 4 秒再检测更新，避免启动瞬间和首屏抢网络/CPU
    const first = setTimeout(check, 4000);
    const timer = setInterval(check, 30 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  // 任何下载开始（版本下载/启动自动下载/核心文件下载）→ 自动跳转到下载进度页
  React.useEffect(() => {
    if (downloading && !prevDownloading.current) {
      setPage('download');
    }
    prevDownloading.current = downloading;
  }, [downloading]);

  return (
    <AppShell page={page} onNavigate={setPage}>
      {page === 'home' && (
        <HomePage
          selectedVersion={selectedVersion}
          onSelectVersion={setSelectedVersion}
          onNavigate={(p) => setPage(p)}
        />
      )}
      <React.Suspense fallback={null}>
        {page === 'versions' && <VersionsPage onSelectVersion={setSelectedVersion} />}
        {page === 'mods' && <ModsPage />}
        {page === 'download' && <DownloadPage />}
        {page === 'settings' && <SettingsPage />}
      </React.Suspense>

      {/* 崩溃分析 */}
      <Dialog open={crash !== null} onOpenChange={(o) => !o && clearCrash()}>
        <DialogContent hideClose>
          <DialogHeader>
            <DialogTitle>{t('crash.title')}</DialogTitle>
            <DialogDescription>{crash?.summary || t('crash.fallback')}</DialogDescription>
          </DialogHeader>
          {crash?.causedBy ? <p className="text-xs text-[#DC2626]">{crash.causedBy}</p> : null}
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-300">
            {crash?.detail || ''}
          </pre>
          <div className="flex flex-wrap justify-end gap-2">
            {crash?.crashPath ? (
              <Button variant="outline" onClick={() => void window.mcore.revealPath(crash.crashPath)}>
                {t('crash.report')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void window.mcore.revealPath(crash?.logPath || crash?.gameDir || '')}
            >
              {t('crash.openLog')}
            </Button>
            <Button onClick={clearCrash}>{t('crash.close')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 更新提示 */}
      <Dialog open={update !== null} onOpenChange={(o) => !o && setUpdate(null)}>
        <DialogContent hideClose>
          <DialogHeader>
            <DialogTitle>发现新版本 {update?.latest}</DialogTitle>
            <DialogDescription>{update?.note}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {updating && (
              <p className="text-sm text-zinc-500">
                正在下载 {update?.latest}… {updatePct}%
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setUpdate(null)} disabled={updating}>
                稍后
              </Button>
              <Button onClick={() => void doApplyUpdate()} disabled={updating}>
                {updating ? `更新中 ${updatePct}%` : '立即更新'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <I18nProvider>
        <AppInner />
      </I18nProvider>
    </AppProvider>
  );
}
