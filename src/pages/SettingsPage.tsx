// 设置页：外观/玻璃/语言/资源源/Java/内存/游戏目录/关闭行为（改即存）
import * as React from 'react';
import { Gauge, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Slider } from '../components/ui/slider';
import { Switch } from '../components/ui/switch';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import defaultWallpaper from '../assets/wallpaper.png';
import type { CloseAction, JavaRuntime, LanguageMode, SourceMode, SourceTestResult, ThemeMode } from '../../electron/types';

function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between md:gap-8">
      <div className="min-w-0 md:w-72">
        <Label>{title}</Label>
        {desc && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{desc}</p>}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">{children}</div>
    </div>
  );
}

export function SettingsPage(): React.JSX.Element {
  const { t, lang, setLang, langs } = useI18n();
  const { settings, updateSettings, javaList, setJavaList, sourceResults, setSourceResults } = useApp();
  const [mirrors, setMirrors] = React.useState<{ id: string; name: string }[]>([]);
  const [testing, setTesting] = React.useState(false);
  const [scanningJava, setScanningJava] = React.useState(false);
  const [javaInput, setJavaInput] = React.useState('');
  const [gameDirInput, setGameDirInput] = React.useState('');

  React.useEffect(() => {
    window.mcore.getMirrors().then((m) => {
      setMirrors(m.clientSources.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name })));
    });
  }, []);

  React.useEffect(() => {
    setJavaInput(settings?.javaPath ?? '');
  }, [settings?.javaPath]);

  React.useEffect(() => {
    setGameDirInput(settings?.gameDir ?? '');
  }, [settings?.gameDir]);

  // 首次进入自动扫描一次 Java
  React.useEffect(() => {
    if (javaList.length === 0) void rescanJava();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rescanJava = async () => {
    setScanningJava(true);
    try {
      setJavaList(await window.mcore.scanJava());
    } finally {
      setScanningJava(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setSourceResults(await window.mcore.testSources());
    } finally {
      setTesting(false);
    }
  };

  const pickWallpaper = async () => {
    const p = await window.mcore.pickWallpaper();
    if (p) {
      await updateSettings({ wallpaper: p });
      toast.success(t('common.saved'));
    }
  };

  // ---- 更新检测 ----
  const [appVersion, setAppVersion] = React.useState('');
  const [updateInfo, setUpdateInfo] = React.useState<{ hasUpdate: boolean; latest: string; note: string; url: string } | null>(null);
  const [checking, setChecking] = React.useState(false);

  React.useEffect(() => {
    window.mcore.getAppInfo().then((i) => setAppVersion(i.version)).catch(() => undefined);
  }, []);

  const applyUpdateNow = async () => {
    const r = await window.mcore.applyUpdate();
    if (!r.ok) toast.error(r.error);
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await window.mcore.checkUpdate();
      setUpdateInfo(r);
      if (r.hasUpdate) {
        toast.success(`发现新版本 ${r.latest}`);
      } else {
        toast.success(t('settings.update.none'));
      }
    } finally {
      setChecking(false);
    }
  };

  const apply = async (patch: Partial<{
    theme: ThemeMode;
    glassEnabled: boolean;
    glassOpacity: number;
    language: LanguageMode;
    sourceMode: SourceMode;
    manualSourceId: string;
    memoryGB: number;
    javaPath: string;
    gameDir: string;
    closeAction: CloseAction;
    wallpaper: string;
  }>) => {
    await updateSettings(patch);
    toast.success(t('common.saved'));
  };

  if (!settings) return <p className="text-sm text-zinc-500">{t('common.loading')}</p>;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('settings.title')}</h1>
      </section>

      {/* 外观 */}
      <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
        <SettingRow title={t('settings.theme')}>
          <Select value={settings.theme} onValueChange={(v) => void apply({ theme: v as ThemeMode })}>
            <SelectTrigger className="w-40" aria-label={t('settings.theme')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.theme.system')}</SelectItem>
              <SelectItem value="light">{t('settings.theme.light')}</SelectItem>
              <SelectItem value="dark">{t('settings.theme.dark')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title={t('settings.glass')} desc={t('settings.glass.desc')}>
          <Switch
            checked={settings.glassEnabled}
            onCheckedChange={(v) => void apply({ glassEnabled: v })}
            aria-label={t('settings.glass')}
          />
        </SettingRow>
        <SettingRow title={t('settings.glass.opacity')}>
          <div className="flex w-full max-w-56 items-center gap-3">
            <Slider
              value={[settings.glassOpacity]}
              min={0}
              max={100}
              step={1}
              disabled={!settings.glassEnabled}
              onValueCommit={(v) => void updateSettings({ glassOpacity: v[0] })}
            />
            <span className="w-10 shrink-0 text-right text-sm text-zinc-500">{settings.glassOpacity}%</span>
          </div>
        </SettingRow>
        <SettingRow title={t('settings.wallpaper')} desc={t('settings.wallpaper.desc')}>
          <div className="flex items-center gap-3">
            <div className="h-12 w-20 shrink-0 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
              <img
                src={
                  settings.wallpaper
                    ? `mcore-wallpaper://local/${encodeURIComponent(settings.wallpaper)}`
                    : defaultWallpaper
                }
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => void pickWallpaper()}>
              {t('settings.wallpaper.pick')}
            </Button>
            {settings.wallpaper && (
              <Button size="sm" variant="ghost" onClick={() => void apply({ wallpaper: '' })}>
                {t('settings.wallpaper.reset')}
              </Button>
            )}
          </div>
        </SettingRow>
      </Card>

      {/* 语言 */}
      <Card>
        <SettingRow title={t('settings.language')} desc={t('settings.language.desc')}>
          <Select
            value={settings.language === 'system' ? 'system' : lang}
            onValueChange={(v) => {
              if (v === 'system') {
                void apply({ language: 'system' });
              } else {
                setLang(v);
                void apply({ language: v });
              }
            }}
          >
            <SelectTrigger className="w-44" aria-label={t('settings.language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.theme.system')}</SelectItem>
              {langs.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </Card>

      {/* 资源源 */}
      <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
        <SettingRow title={t('settings.source.mode')}>
          <Select value={settings.sourceMode} onValueChange={(v) => void apply({ sourceMode: v as SourceMode })}>
            <SelectTrigger className="w-64" aria-label={t('settings.source.mode')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('settings.source.mode.auto')}</SelectItem>
              <SelectItem value="manual">{t('settings.source.mode.manual')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {settings.sourceMode === 'manual' && (
          <SettingRow title={t('settings.source.manual')}>
            <Select value={settings.manualSourceId} onValueChange={(v) => void apply({ manualSourceId: v })}>
              <SelectTrigger className="w-64" aria-label={t('settings.source.manual')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mirrors.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
        <SettingRow title={t('settings.source.test')}>
          <Button variant="outline" size="sm" onClick={() => void runTest()} disabled={testing}>
            <Gauge className="h-4 w-4" strokeWidth={1.5} />
            {testing ? t('settings.source.testing') : t('settings.source.test')}
          </Button>
        </SettingRow>
        {sourceResults.length > 0 && (
          <div className="flex flex-col gap-2 py-4">
            {sourceResults.map((r: SourceTestResult) => (
              <div key={r.sourceId} className="flex items-center justify-between text-sm">
                <span className="text-zinc-600 dark:text-zinc-300">{r.name}</span>
                <span className="flex items-center gap-3 text-xs">
                  {r.ok ? (
                    <>
                      <span className="rounded-md bg-[#16A34A]/10 px-2 py-0.5 font-medium text-[#16A34A]">
                        {t('settings.source.ok')} · {r.speedKBs} KB/s · {r.latencyMs}ms
                      </span>
                    </>
                  ) : (
                    <span className="rounded-md bg-[#DC2626]/10 px-2 py-0.5 font-medium text-[#DC2626]">
                      {t('settings.source.bad')} · {r.error}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Java */}
      <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
        <SettingRow title={t('settings.java.path')}>
          <div className="flex w-full max-w-md items-center gap-2">
            <Input
              value={javaInput}
              onChange={(e) => setJavaInput(e.target.value)}
              placeholder="/usr/lib/jvm/…/bin/java"
              className="font-mono text-xs"
            />
            <Button size="sm" variant="outline" onClick={() => void apply({ javaPath: javaInput.trim() })}>
              {t('common.save')}
            </Button>
          </div>
        </SettingRow>
        <SettingRow title={t('settings.java.rescan')}>
          <Button variant="outline" size="sm" onClick={() => void rescanJava()} disabled={scanningJava}>
            <Search className="h-4 w-4" strokeWidth={1.5} />
            {scanningJava ? t('settings.java.scanning') : t('settings.java.rescan')}
          </Button>
        </SettingRow>
        <div className="flex flex-col gap-1 py-4">
          {javaList.length === 0 ? (
            <p className="text-xs text-zinc-500">{t('settings.java.none')}</p>
          ) : (
            <>
              <p className="mb-1 text-xs text-zinc-500">{t('settings.java.found', { count: javaList.length })}</p>
              {javaList.map((j: JavaRuntime) => (
                <div key={j.path} className="flex items-center justify-between text-sm">
                  <span className="min-w-0 truncate font-mono text-xs text-zinc-600 dark:text-zinc-300">{j.path}</span>
                  <span className="ml-3 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                    Java {j.version} · {j.source}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </Card>

      {/* 内存 / 游戏目录 / 关闭行为 */}
      <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
        <SettingRow title={t('settings.memory')} desc={t('settings.memory.desc')}>
          <div className="flex w-full max-w-56 items-center gap-3">
            <Slider
              value={[settings.memoryGB]}
              min={1}
              max={16}
              step={1}
              onValueChange={(v) => void updateSettings({ memoryGB: v[0] })}
              aria-label={t('settings.memory')}
            />
            <span className="w-10 shrink-0 text-right text-sm text-zinc-500">{settings.memoryGB}G</span>
          </div>
        </SettingRow>
        <SettingRow title={t('settings.gamedir')} desc={t('settings.gamedir.desc')}>
          <Input
            value={gameDirInput}
            onChange={(e) => setGameDirInput(e.target.value)}
            onBlur={() => {
              if (gameDirInput !== settings.gameDir) void apply({ gameDir: gameDirInput.trim() });
            }}
            placeholder=".minecraft"
            className="max-w-md font-mono text-xs"
          />
        </SettingRow>
        <SettingRow title={t('settings.close')}>
          <Select value={settings.closeAction} onValueChange={(v) => void apply({ closeAction: v as CloseAction })}>
            <SelectTrigger className="w-44" aria-label={t('settings.close')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">{t('settings.close.ask')}</SelectItem>
              <SelectItem value="exit">{t('settings.close.exit')}</SelectItem>
              <SelectItem value="tray">{t('settings.close.tray')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </Card>

      {/* 关于 / 更新检测 */}
      <Card>
        <SettingRow title={t('settings.update.title')} desc={t('settings.update.desc')}>
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-500">{t('settings.update.current', { version: appVersion || '…' })}</span>
            <Button variant="outline" size="sm" onClick={() => void runCheck()} disabled={checking}>
              {checking ? t('settings.source.testing') : t('settings.update.check')}
            </Button>
          </div>
        </SettingRow>
        {updateInfo?.hasUpdate && (
          <div className="flex flex-col gap-2 py-4">
            <p className="text-sm font-medium">
              {t('settings.update.found', { version: updateInfo.latest })}
            </p>
            {updateInfo.note && <p className="text-xs text-zinc-500 dark:text-zinc-400">{updateInfo.note}</p>}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void applyUpdateNow()}>
                {t('settings.update.apply')}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
