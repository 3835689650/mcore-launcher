// 启动页：账户选择、版本选择、启动、游戏日志（下载详情在下载页）
import * as React from 'react';
import { Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { InstalledVersion } from '../../electron/types';

export function HomePage({
  selectedVersion,
  onSelectVersion,
  onNavigate,
}: {
  selectedVersion: string;
  onSelectVersion: (id: string) => void;
  onNavigate: (p: 'download') => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const {
    settings,
    updateSettings,
    downloadDone,
    downloadTotal,
    downloading,
    logs,
    clearLogs,
    gameRunning,
    setGameRunning,
  } = useApp();
  const [launching, setLaunching] = React.useState(false);
  const [installed, setInstalled] = React.useState<InstalledVersion[]>([]);

  // 本地已安装版本（含 Forge/NeoForge/Fabric 等加载器版本）
  const refreshInstalled = React.useCallback(async () => {
    try {
      setInstalled(await window.mcore.listInstalledVersions());
    } catch {
      setInstalled([]);
    }
  }, []);

  React.useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // 下载结束（成功/失败）后刷新已安装列表
  React.useEffect(() => window.mcore.onDownloadEnd(() => void refreshInstalled()), [refreshInstalled]);
  const logRef = React.useRef<HTMLDivElement>(null);

  const accounts = settings?.accounts ?? [];
  const current = settings?.currentAccount ?? '';

  // 选中项不是已安装版本时，自动切到第一个已安装版本
  React.useEffect(() => {
    if (installed.length === 0) return;
    if (!installed.some((v) => v.id === selectedVersion)) {
      onSelectVersion(installed[0].id);
    }
  }, [installed, selectedVersion, onSelectVersion]);

  // 日志自动滚底
  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const switchAccount = (name: string) => {
    void updateSettings({ currentAccount: name, username: name });
  };

  const launch = async () => {
    const name = current;
    if (!name) {
      toast.error(t('account.none'));
      return;
    }
    if (!selectedVersion) {
      toast.error(t('servers.selectVersionFirst'));
      return;
    }
    setLaunching(true);
    try {
      const r = await window.mcore.launch({
        versionId: selectedVersion,
        username: name,
        javaPath: settings?.javaPath ?? '',
        memoryGB: settings?.memoryGB ?? 2,
        gameDir: settings?.gameDir ?? '',
        serverAddress: '',
        serverPort: 25565,
      });
      if (r.ok) setGameRunning(true);
      else if (r.error !== '已取消') toast.error(r.error);
    } finally {
      setLaunching(false);
    }
  };

  // 只展示本地已安装的版本（原版 + 加载器版本）
  const versionOptions = installed;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('home.title')}</h1>
        <p className="mt-2 text-base leading-7 text-zinc-500 dark:text-zinc-400">{t('home.subtitle')}</p>
      </section>

      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>{t('home.selectAccount')}</Label>
            <Select value={current || undefined} onValueChange={switchAccount}>
              <SelectTrigger aria-label={t('home.selectAccount')}>
                <SelectValue placeholder={t('account.none')} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.name} value={a.name}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t('home.selectVersion')}</Label>
            <Select value={selectedVersion || undefined} onValueChange={onSelectVersion}>
              <SelectTrigger aria-label={t('home.selectVersion')}>
                <SelectValue
                  placeholder={versionOptions.length === 0 ? t('home.noInstalledVersion') : t('home.selectVersion')}
                />
              </SelectTrigger>
              <SelectContent>
                {versionOptions.map((v: InstalledVersion) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.id}
                    {v.loader ? ` · ${v.loader}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-4 pt-2">
            {!gameRunning ? (
              <Button size="lg" onClick={launch} disabled={launching || downloading || !current} className="min-w-40">
                <Play className="h-4 w-4" strokeWidth={1.5} />
                {launching ? t('common.loading') : t('home.launch')}
              </Button>
            ) : (
              <Button size="lg" variant="danger" onClick={() => void window.mcore.stopLaunch()} className="min-w-40">
                <Square className="h-4 w-4" strokeWidth={1.5} />
                {t('home.stopGame')}
              </Button>
            )}
            {downloading && (
              <button
                type="button"
                onClick={() => onNavigate('download')}
                className="text-sm text-[#2563EB] underline-offset-4 hover:underline dark:text-blue-400"
              >
                {t('home.downloading', { done: downloadDone, total: downloadTotal })}
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* 下载进度 */}

      {/* 游戏日志 */}
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold md:text-2xl">{t('log.title')}</h2>
          <Button size="sm" variant="ghost" onClick={clearLogs}>
            {t('log.clear')}
          </Button>
        </div>
        <div
          ref={logRef}
          className={cn(
            'selectable mt-4 h-56 overflow-y-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-300',
            logs.length === 0 && 'flex items-center justify-center text-zinc-600',
          )}
        >
          {logs.length === 0
            ? t('log.empty')
            : logs.map((l, i) => (
                <div key={i} className={cn('whitespace-pre-wrap break-all', l.stream === 'stderr' && 'text-[#f87171]', l.stream === 'info' && 'text-zinc-500')}>
                  {l.line}
                </div>
              ))}
        </div>
      </Card>
    </div>
  );
}

