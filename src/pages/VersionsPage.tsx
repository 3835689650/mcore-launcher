// 版本页：全量版本列表（虚拟滚动）+ 类型过滤 + HMCL 式安装（原版/模组加载器）+ 启动
import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, Play, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { LoaderKind, LoaderVersions, VersionFilter, VersionManifestEntry } from '../../electron/types';

/** 该加载器在私有源是否有实际版本资源 */
function loaderHasVersions(list: LoaderVersions[], kind: string): boolean {
  const lv = list.find((x) => x.kind === kind);
  return (lv?.versions.length ?? 0) > 0;
}

const FILTER_OPTIONS: { value: VersionFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'versions.filter.all' },
  { value: 'release', labelKey: 'versions.filter.release' },
  { value: 'snapshot', labelKey: 'versions.filter.snapshot' },
  { value: 'old', labelKey: 'versions.filter.old' },
];

function typeBadge(type: string, t: (k: string) => string): string {
  if (type === 'release') return t('versions.filter.release');
  if (type === 'snapshot') return t('versions.filter.snapshot');
  return t('versions.filter.old');
}

export function VersionsPage({
  onSelectVersion,
}: {
  onSelectVersion: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { settings, updateSettings, versions, setVersions, downloading, setGameRunning } = useApp();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const parentRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await window.mcore.listVersions();
      setVersions(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setVersions]);

  React.useEffect(() => {
    if (versions.length === 0) void load();
  }, [versions.length, load]);

  const filter = settings?.versionFilter ?? 'all';
  const filtered = React.useMemo(() => {
    if (filter === 'all') return versions;
    if (filter === 'old') return versions.filter((v) => v.type !== 'release' && v.type !== 'snapshot');
    return versions.filter((v) => v.type === filter);
  }, [versions, filter]);

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  // ---- HMCL 式安装弹窗状态 ----
  const [installTarget, setInstallTarget] = React.useState<VersionManifestEntry | null>(null);
  const [dlKind, setDlKind] = React.useState<LoaderKind | ''>('');
  const [dlVersions, setDlVersions] = React.useState<LoaderVersions[]>([]);
  const [dlVersion, setDlVersion] = React.useState('');
  const [installing, setInstalling] = React.useState(false);

  const openInstall = async (v: VersionManifestEntry) => {
    setInstallTarget(v);
    setDlKind('');
    setDlVersion('');
    setDlVersions([]);
    try {
      setDlVersions(await window.mcore.listLoaders(v.id));
    } catch {
      setDlVersions([]);
    }
  };

  const confirmInstall = async () => {
    if (!installTarget) return;
    setInstalling(true);
    try {
      const r = await window.mcore.installVersion(installTarget.id, dlKind, dlVersion);
      if (r.ok) {
        toast.success(`${r.versionId || installTarget.id} 安装完成，可在首页启动`);
        setInstallTarget(null);
      } else if (r.error !== '已取消') {
        toast.error(r.error);
      }
    } finally {
      setInstalling(false);
    }
  };

  const launch = async (id: string) => {
    onSelectVersion(id);
    const r = await window.mcore.launch({
      versionId: id,
      username: settings?.currentAccount || settings?.username || '',
      javaPath: settings?.javaPath ?? '',
      memoryGB: settings?.memoryGB ?? 2,
      gameDir: settings?.gameDir ?? '',
      serverAddress: '',
      serverPort: 25565,
    });
    if (r.ok) setGameRunning(true);
    else if (r.error !== '已取消') toast.error(r.error);
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('versions.title')}</h1>
          <p className="mt-2 text-base leading-7 text-zinc-500 dark:text-zinc-400">
            {versions.length > 0 ? `${filtered.length} / ${versions.length}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Select
            value={filter}
            onValueChange={(v) => void updateSettings({ versionFilter: v as VersionFilter })}
          >
            <SelectTrigger className="w-36" aria-label={t('versions.title')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void load()} aria-label={t('common.refresh')}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} strokeWidth={1.5} />
          </Button>
        </div>
      </section>

      {loading && <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('versions.loading')}</p>}
      {error && (
        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[#DC2626]">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t('versions.retry')}
            </Button>
          </div>
        </Card>
      )}
      {!loading && !error && filtered.length === 0 && (
        <Card>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('versions.empty')}</p>
        </Card>
      )}

      {filtered.length > 0 && (
        <Card className="p-0">
          <div ref={parentRef} className="max-h-[calc(100vh-300px)] min-h-[300px] overflow-y-auto rounded-lg">
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((row) => {
                const v: VersionManifestEntry = filtered[row.index];
                return (
                  <VersionRow
                    key={v.id}
                    entry={v}
                    downloading={downloading}
                    onDownload={() => void openInstall(v)}
                    onLaunch={() => void launch(v.id)}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${row.start}px)`,
                    }}
                  />
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* HMCL 式安装弹窗：原版 / 模组加载器 */}
      <Dialog open={installTarget !== null} onOpenChange={(o) => !o && setInstallTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('versions.installTitle')} {installTarget?.id ?? ''}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>{t('home.loader')}</Label>
              <Select
                value={dlKind || 'none'}
                onValueChange={(k) => {
                  setDlKind((k === 'none' ? '' : k) as LoaderKind | '');
                  setDlVersion('');
                }}
              >
                <SelectTrigger aria-label={t('home.loader')}>
                  <SelectValue placeholder={t('home.loader.none')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('home.loader.none')}</SelectItem>
                  <SelectItem value="forge">Forge</SelectItem>
                  <SelectItem value="neoforge">NeoForge</SelectItem>
                  <SelectItem value="fabric">Fabric</SelectItem>
                  <SelectItem value="quilt">Quilt</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {dlKind !== '' && (
              <div className="flex flex-col gap-2">
                <Label>{t('home.loaderVersion')}</Label>
                <Select value={dlVersion || undefined} onValueChange={setDlVersion}>
                  <SelectTrigger aria-label={t('home.loaderVersion')}>
                    <SelectValue
                      placeholder={
                        !loaderHasVersions(dlVersions, dlKind)
                          ? t('versions.noLoaderVersion', { loader: dlKind })
                          : t('home.loaderVersion')
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {dlVersions
                      .find((lv) => lv.kind === dlKind)
                      ?.versions.map((v) => (
                        <SelectItem key={v.version} value={v.version}>
                          {v.version}
                          {v.stable ? '' : ' (dev)'}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setInstallTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => void confirmInstall()}
                disabled={installing || (dlKind !== '' && !loaderHasVersions(dlVersions, dlKind))}
              >
                {installing ? t('common.loading') : t('versions.install')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 版本行：本地就绪状态独立查询（可视行内，本地文件检查开销小）+ 删除已下载版本 */
const VersionRow = React.memo(function VersionRow({
  entry,
  downloading,
  onDownload,
  onLaunch,
  style,
}: {
  entry: VersionManifestEntry;
  downloading: boolean;
  onDownload: () => void;
  onLaunch: () => void;
  style: React.CSSProperties;
}): React.JSX.Element {
  const { t } = useI18n();
  const [ready, setReady] = React.useState(false);

  const checkReady = React.useCallback(() => {
    let alive = true;
    window.mcore.isVersionReady(entry.id).then((r) => {
      if (alive) setReady(r.ready);
    });
    return () => {
      alive = false;
    };
  }, [entry.id]);

  React.useEffect(() => checkReady(), [checkReady]);

  const handleDelete = async () => {
    if (!window.confirm(t('versions.deleteConfirm', { version: entry.id }))) return;
    const r = await window.mcore.deleteVersion(entry.id);
    if (r.ok) {
      toast.success(t('versions.deleted'));
      checkReady();
    } else {
      toast.error(r.error);
    }
  };

  return (
    <div
      style={style}
      className="flex h-[52px] items-center gap-4 border-b border-zinc-100 px-4 last:border-b-0 dark:border-zinc-800"
    >
      <span
        className={cn(
          'w-24 shrink-0 rounded-md px-2 py-0.5 text-center text-xs',
          entry.type === 'release'
            ? 'bg-[#2563EB]/10 text-[#2563EB] dark:text-blue-400'
            : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400',
        )}
      >
        {typeBadge(entry.type, t)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.id}</span>
      <span className="hidden shrink-0 text-xs text-zinc-400 md:block">{entry.releaseTime?.slice(0, 10) ?? ''}</span>
      {ready ? <span className="shrink-0 text-xs text-[#16A34A]">{t('versions.ready')}</span> : null}
      {ready ? (
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => void handleDelete()} aria-label={t('versions.delete')}>
          <Trash2 className="h-4 w-4 text-[#DC2626]" strokeWidth={1.5} />
        </Button>
      ) : null}
      {/* 已安装 → 下载置灰；未安装 → 启动置灰 */}
      {/* 已就绪也可再次打开安装对话框：用于给原版加装 Forge/NeoForge/Fabric 加载器 */}
      <Button size="sm" variant="outline" onClick={onDownload} disabled={downloading}>
        <Download className="h-4 w-4" strokeWidth={1.5} />
        {t('versions.install')}
      </Button>
      <Button size="sm" onClick={onLaunch} disabled={downloading || !ready}>
        <Play className="h-4 w-4" strokeWidth={1.5} />
        {t('versions.launch')}
      </Button>
    </div>
  );
});
