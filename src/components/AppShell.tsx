// 应用外壳：左侧导航 + 账户管理 + 内容区；玻璃光斑与壁纸背景
import * as React from 'react';
import { Boxes, Download, Home, Puzzle, Plus, Settings, Blocks } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../lib/utils';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import wallpaper from '../assets/wallpaper.png';

export type PageId = 'home' | 'versions' | 'mods' | 'download' | 'settings';

const NAV_ITEMS: { id: PageId; icon: typeof Home; labelKey: string }[] = [
  { id: 'home', icon: Home, labelKey: 'nav.home' },
  { id: 'versions', icon: Boxes, labelKey: 'nav.versions' },
  { id: 'mods', icon: Puzzle, labelKey: 'nav.mods' },
  { id: 'download', icon: Download, labelKey: 'nav.download' },
  { id: 'settings', icon: Settings, labelKey: 'nav.settings' },
];

export function AppShell({
  page,
  onNavigate,
  children,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const { settings, updateSettings } = useApp();
  const glassOn = settings?.glassEnabled ?? true;
  const [addOpen, setAddOpen] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [appVersion, setAppVersion] = React.useState('');

  React.useEffect(() => {
    window.mcore
      .getAppInfo()
      .then((i) => setAppVersion(i.version))
      .catch(() => undefined);
  }, []);

  const accounts = settings?.accounts ?? [];
  const current = settings?.currentAccount ?? '';

  const addAccount = async () => {
    const name = newName.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      toast.error(t('home.usernameError'));
      return;
    }
    if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      toast.error(t('account.duplicate'));
      return;
    }
    await updateSettings({
      accounts: [...accounts, { name }],
      currentAccount: name,
      username: name,
    });
    setAddOpen(false);
    setNewName('');
    toast.success(t('common.saved'));
  };

  // 壁纸源：自定义壁纸走专属协议，否则内置默认壁纸
  const wallpaperSrc = settings?.wallpaper
    ? `mcore-wallpaper://local/${encodeURIComponent(settings.wallpaper)}`
    : wallpaper;

  return (
    <div
      data-glass={glassOn ? 'on' : 'off'}
      className="relative flex h-full"
      style={{ '--glass-alpha': `${settings?.glassOpacity ?? 70}` } as React.CSSProperties}
    >
      {/* 壁纸层：铺满整个界面底层，遮罩随主题自动适配明暗 */}
      <img
        src={wallpaperSrc}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover brightness-100 dark:brightness-100"
      />
      <div
        className="pointer-events-none absolute inset-0 -z-10 bg-white/30 dark:bg-zinc-950/70"
        aria-hidden="true"
      />

      {/* 装饰光斑：仅玻璃开启时显示 */}
      {glassOn && (
        <div aria-hidden="true">
          <div className="glass-orb h-96 w-96 bg-[#2563EB]/[0.14] dark:bg-[#2563EB]/[0.10]" style={{ top: -96, left: 96 }} />
          <div className="glass-orb h-80 w-80 bg-zinc-400/[0.10] dark:bg-zinc-600/[0.08]" style={{ bottom: -64, right: 64 }} />
        </div>
      )}

      {/* 左侧导航 */}
      <aside className="mc-panel z-10 flex w-56 shrink-0 flex-col gap-4 border-r border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center gap-3 px-2 pt-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#2563EB]">
            <Blocks className="h-5 w-5 text-white" strokeWidth={1.5} />
          </div>
          <div>
            <div className="text-sm font-semibold leading-5">{t('app.name')}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('app.slogan')}</div>
          </div>
        </div>

        {/* 账户区块 */}
        <div className="mc-panel flex items-center gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2563EB]/15 text-sm font-semibold text-[#2563EB] dark:text-blue-400">
            {current ? current.slice(0, 1).toUpperCase() : '?'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{current || t('account.none')}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('account.title')}</div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => setAddOpen(true)}
            aria-label={t('account.add')}
          >
            <Plus className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </div>

        <nav className="flex flex-col gap-2" aria-label="主导航">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2563EB]',
                  active
                    ? 'bg-[#2563EB] font-medium text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={1.5} />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto px-2 text-xs text-zinc-400 dark:text-zinc-500">MCore v{appVersion || '…'}</div>
      </aside>

      {/* 内容区 */}
      <main className="z-10 min-w-0 flex-1 overflow-y-auto" role="main">
        <div className="mx-auto max-w-4xl px-6 py-8">{children}</div>
      </main>

      {/* 添加账户弹窗 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('account.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-account-name">{t('account.name')}</Label>
            <Input
              id="new-account-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('home.usernamePlaceholder')}
              maxLength={16}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addAccount();
              }}
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void addAccount()}>{t('common.confirm')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
