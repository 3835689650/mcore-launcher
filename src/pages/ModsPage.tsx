// 模组页：搜索 / 安装 Modrinth 模组（镜像优先、官方兜底），管理本地 mods 目录
import * as React from 'react';
import { Download, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../lib/i18n';
import { cn, formatBytes } from '../lib/utils';
import type { InstalledMod, InstalledVersion, ModHit, ModUpdate } from '../../electron/types';

const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

export function ModsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [installedVersions, setInstalledVersions] = React.useState<InstalledVersion[]>([]);
  const [mcVersion, setMcVersion] = React.useState('');
  const [loader, setLoader] = React.useState('fabric');
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState('downloads');
  const [hits, setHits] = React.useState<ModHit[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [installing, setInstalling] = React.useState('');
  const [error, setError] = React.useState('');
  const [mods, setMods] = React.useState<InstalledMod[]>([]);
  const [updates, setUpdates] = React.useState<ModUpdate[]>([]);
  const [checking, setChecking] = React.useState(false);
  const searchSeq = React.useRef(0);

  const refreshMods = React.useCallback(async () => {
    try {
      setMods(await window.mcore.listInstalledMods());
    } catch {
      setMods([]);
    }
  }, []);

  // 初始化：本地版本（用于默认 MC 版本 / 加载器）+ 已装模组
  React.useEffect(() => {
    void (async () => {
      const [vs, ms] = await Promise.all([
        window.mcore.listInstalledVersions().catch(() => []),
        window.mcore.listInstalledMods().catch(() => []),
      ]);
      setInstalledVersions(vs);
      setMods(ms);
      const preferred = vs.find((v) => v.loader) ?? vs[0];
      if (preferred?.mcVersion) {
        setMcVersion(preferred.mcVersion);
      } else {
        // 还没装任何版本：退回官方版本清单的正式版，保证模组页可用
        try {
          const list = await window.mcore.listVersions();
          const first = list.find((v) => v.type === 'release');
          if (first) setMcVersion(first.id);
        } catch {
          // 断网且无本地版本 → 保持空态提示
        }
      }
      if (preferred?.loader) setLoader(preferred.loader);
    })();
  }, []);

  const doSearch = React.useCallback(
    async (reset: boolean) => {
      const seq = ++searchSeq.current;
      setLoading(true);
      setError('');
      try {
        const off = reset ? 0 : offset;
        const r = await window.mcore.searchMods({
          query,
          mcVersion,
          loader,
          offset: off,
          limit: 20,
          sort: query ? 'relevance' : sort,
        });
        if (seq !== searchSeq.current) return;
        setHits((prev) => (reset ? r.hits : [...prev, ...r.hits]));
        setTotal(r.total);
        setOffset(off + r.hits.length);
      } catch (e) {
        if (seq === searchSeq.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === searchSeq.current) setLoading(false);
      }
    },
    [mcVersion, loader, offset, query, sort],
  );

  // 版本/加载器/排序变化时自动重新搜索（空关键词=按下载量推荐）
  React.useEffect(() => {
    if (!mcVersion) return;
    void doSearch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcVersion, loader, sort]);

  const install = async (hit: ModHit) => {
    const id = hit.slug || hit.id;
    setInstalling(id);
    try {
      const r = await window.mcore.installMod({ idOrSlug: id, mcVersion, loader });
      if (r.ok) {
        toast.success(
          `${hit.title} ${t('mods.installOk')}${r.dependencies > 0 ? `（+${r.dependencies} ${t('mods.deps')}）` : ''}`,
        );
        await refreshMods();
      } else {
        toast.error(r.error);
      }
    } finally {
      setInstalling('');
    }
  };

  const toggle = async (m: InstalledMod, enabled: boolean) => {
    const r = await window.mcore.setModEnabled(m.fileName, enabled);
    if (r.ok) await refreshMods();
    else toast.error(r.error);
  };

  const checkUpdates = async () => {
    if (!mcVersion) return;
    setChecking(true);
    try {
      const r = await window.mcore.checkModUpdates(mcVersion, loader);
      setUpdates(r.updates);
      if (r.updates.length === 0) toast.success(t('mods.noUpdates'));
      else toast.success(t('mods.updateFound', { count: r.updates.length }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async (u: ModUpdate) => {
    setInstalling(u.fileName);
    try {
      const r = await window.mcore.applyModUpdate(u.fileName, {
        url: u.latestUrl,
        filename: u.latestFileName,
        size: u.latestSize,
        sha1: u.latestSha1,
      });
      if (r.ok) {
        toast.success(`${u.latestFileName} ${t('mods.updateDone')}`);
        setUpdates((prev) => prev.filter((x) => x.fileName !== u.fileName));
        await refreshMods();
      } else {
        toast.error(r.error);
      }
    } finally {
      setInstalling('');
    }
  };

  const updateAll = async () => {
    for (const u of [...updates]) {
      await applyUpdate(u);
    }
  };

  const remove = async (m: InstalledMod) => {
    if (!window.confirm(t('mods.deleteConfirm', { name: m.name }))) return;
    const r = await window.mcore.deleteMod(m.fileName);
    if (r.ok) await refreshMods();
    else toast.error(r.error);
  };

  const mcOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const v of installedVersions) if (v.mcVersion) set.add(v.mcVersion);
    return Array.from(set);
  }, [installedVersions]);

  const hasLoaderVersion = installedVersions.some((v) => v.loader);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('mods.title')}</h1>
        <p className="mt-2 text-base leading-7 text-zinc-500 dark:text-zinc-400">{t('mods.subtitle')}</p>
      </section>

      {!hasLoaderVersion && (
        <Card>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('mods.needLoader')}</p>
        </Card>
      )}

      <Card>
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-2">
              <Label>{t('mods.mcVersion')}</Label>
              <Select value={mcVersion || undefined} onValueChange={setMcVersion}>
                <SelectTrigger aria-label={t('mods.mcVersion')}>
                  <SelectValue placeholder={t('mods.noVersion')} />
                </SelectTrigger>
                <SelectContent>
                  {mcOptions.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t('mods.loader')}</Label>
              <Select value={loader} onValueChange={setLoader}>
                <SelectTrigger aria-label={t('mods.loader')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOADERS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t('mods.sort')}</Label>
              <Select value={sort} onValueChange={setSort}>
                <SelectTrigger aria-label={t('mods.sort')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="downloads">{t('mods.sort.downloads')}</SelectItem>
                  <SelectItem value="newest">{t('mods.sort.newest')}</SelectItem>
                  <SelectItem value="follows">{t('mods.sort.follows')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" strokeWidth={1.5} />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doSearch(true);
                }}
                placeholder={t('mods.searchPlaceholder')}
                className="pl-9"
              />
            </div>
            <Button onClick={() => void doSearch(true)} disabled={loading || !mcVersion}>
              {loading ? t('common.loading') : t('mods.search')}
            </Button>
            <Button variant="outline" size="icon" onClick={() => void doSearch(true)} disabled={loading} aria-label={t('common.refresh')}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} strokeWidth={1.5} />
            </Button>
          </div>

          {error && <p className="text-sm text-[#DC2626]">{error}</p>}
          {!error && hits.length === 0 && !loading && (
            <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('mods.empty')}</p>
          )}

          <div className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {hits.map((h) => (
              <div key={h.id || h.slug} className="flex items-start gap-3 py-3">
                {h.iconUrl ? (
                  <img
                    src={h.iconUrl}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-lg bg-zinc-100 object-cover dark:bg-zinc-800"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{h.title}</span>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {t('mods.downloads')} {h.downloads.toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{h.description}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={installing === (h.slug || h.id)}
                  onClick={() => void install(h)}
                  className="shrink-0"
                >
                  <Download className="h-4 w-4" strokeWidth={1.5} />
                  {installing === (h.slug || h.id) ? t('mods.installing') : t('mods.install')}
                </Button>
              </div>
            ))}
          </div>

          {hits.length > 0 && hits.length < total && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => void doSearch(false)} disabled={loading}>
                {t('mods.more')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold md:text-2xl">{t('mods.installed')}</h2>
          <div className="flex items-center gap-2">
            {updates.length > 0 && (
              <Button size="sm" onClick={() => void updateAll()} disabled={installing !== ''}>
                {t('mods.updateAll')} ({updates.length})
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void checkUpdates()} disabled={checking || !mcVersion}>
              {checking ? t('mods.checking') : t('mods.checkUpdates')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refreshMods()}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('mods.installedHint')}</p>
        {mods.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('mods.noInstalled')}</p>
        ) : (
          <div className="mt-3 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {mods.map((m) => (
              <div key={m.fileName} className="flex items-center gap-3 py-2.5">
                <span className={cn('min-w-0 flex-1 truncate text-sm', !m.enabled && 'text-zinc-400 line-through')}>
                  {m.name}
                </span>
                <span className="shrink-0 text-xs text-zinc-400">{formatBytes(m.size)}</span>
                {updates.some((u) => u.fileName === m.fileName) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2 text-[11px]"
                    disabled={installing === m.fileName}
                    onClick={() => {
                      const u = updates.find((x) => x.fileName === m.fileName);
                      if (u) void applyUpdate(u);
                    }}
                  >
                    {installing === m.fileName ? t('mods.updating') : t('mods.update')}
                  </Button>
                )}
                <Switch
                  checked={m.enabled}
                  onCheckedChange={(v) => void toggle(m, v)}
                  aria-label={t('mods.enable')}
                />
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void remove(m)} aria-label={t('mods.delete')}>
                  <Trash2 className="h-4 w-4 text-[#DC2626]" strokeWidth={1.5} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
