// 多语言：外置语言包（主进程 locales 目录），新增 json 文件即新增语言，免重编译
import * as React from 'react';

interface I18nState {
  lang: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  setLang: (lang: string) => void;
  langs: { id: string; label: string }[];
}

const I18nContext = React.createContext<I18nState>({
  lang: 'zh-CN',
  t: (k) => k,
  setLang: () => undefined,
  langs: [],
});

const tableCache = new Map<string, Record<string, string>>();

async function loadTable(id: string): Promise<Record<string, string>> {
  if (tableCache.has(id)) return tableCache.get(id) as Record<string, string>;
  try {
    const table = await window.mcore.loadLanguage(id);
    tableCache.set(id, table);
    return table;
  } catch {
    return {};
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [lang, setLangState] = React.useState('zh-CN');
  const [langs, setLangs] = React.useState<{ id: string; label: string }[]>([]);
  const [table, setTable] = React.useState<Record<string, string>>({});
  const [enTable, setEnTable] = React.useState<Record<string, string>>({});
  // 语言包加载完成前不渲染子内容，避免 key 文本闪烁
  const [ready, setReady] = React.useState(false);

  // 初始化：语言列表 + 当前语言包（system 跟随系统）
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await window.mcore.getLanguages();
        if (!alive) return;
        setLangs(list);
        const settings = await window.mcore.getSettings();
        const resolved =
          settings.language === 'system' ? await window.mcore.resolveSystemLanguage() : settings.language;
        const tbl = await loadTable(resolved);
        const en = await loadTable('en-US');
        if (!alive) return;
        setTable(tbl);
        setEnTable(en);
        setLangState(resolved);
        setReady(true);
        document.documentElement.lang = resolved;
      } catch {
        // 初始化失败也放行渲染（key 兜底显示）
        setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const t = React.useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let text = table[key] ?? enTable[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    [table, enTable],
  );

  const setLang = React.useCallback((id: string) => {
    setLangState(id);
    document.documentElement.lang = id;
    loadTable(id).then(setTable);
  }, []);

  const value = React.useMemo(() => ({ lang, t, setLang, langs }), [lang, t, setLang, langs]);

  // 语言包加载完成前不渲染子内容（避免 key 文本闪烁）；早退必须放在全部 hooks 之后
  if (!ready) return <div />;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  return React.useContext(I18nContext);
}
