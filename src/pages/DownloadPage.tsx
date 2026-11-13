// 下载页：全部下载任务（含历史）的总进度、文件级状态与取消
import * as React from 'react';
import { Download, XCircle } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { cn, formatBytes } from '../lib/utils';
import type { DownloadTask } from '../../electron/types';

const STATUS_ORDER: Record<DownloadTask['status'], number> = {
  downloading: 0,
  verify: 1,
  pending: 2,
  failed: 3,
  done: 4,
};

function statusLabel(status: DownloadTask['status'], t: (k: string) => string): string {
  switch (status) {
    case 'downloading':
      return t('dl.downloading');
    case 'verify':
      return t('dl.verify');
    case 'pending':
      return t('dl.pending');
    case 'failed':
      return t('dl.failed');
    default:
      return t('dl.done');
  }
}

export function DownloadPage(): React.JSX.Element {
  const { t } = useI18n();
  const { downloads, downloadDone, downloadTotal, downloading } = useApp();

  const tasks = React.useMemo(() => {
    return Array.from(downloads.values()).sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
    );
  }, [downloads]);

  const failedCount = tasks.filter((x) => x.status === 'failed').length;
  const totalPct = downloadTotal > 0 ? Math.round((downloadDone / downloadTotal) * 100) : 0;
  const downloadingCount = tasks.filter((x) => x.status === 'downloading' || x.status === 'verify').length;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('dl.title')}</h1>
          <p className="mt-2 text-base leading-7 text-zinc-500 dark:text-zinc-400">
            {tasks.length > 0 ? `${downloadDone} / ${downloadTotal} · ${formatBytes(totalDownloaded(tasks))}` : ''}
          </p>
        </div>
        {downloading && (
          <Button variant="outline" size="sm" onClick={() => void window.mcore.cancelDownload()}>
            <XCircle className="h-4 w-4" strokeWidth={1.5} />
            {t('dl.cancel')}
          </Button>
        )}
      </section>

      {tasks.length === 0 && (
        <Card>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Download className="h-8 w-8 text-zinc-300 dark:text-zinc-600" strokeWidth={1.5} />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('dl.empty')}</p>
          </div>
        </Card>
      )}

      {tasks.length > 0 && (
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Progress value={totalPct} className="flex-1" />
              <span className="w-12 shrink-0 text-right text-sm text-zinc-500">{totalPct}%</span>
            </div>
            {downloadingCount > 0 && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {t('dl.active', { count: downloadingCount })}
              </p>
            )}
            {failedCount > 0 && (
              <p className="text-sm text-[#DC2626]">{t('dl.failedFiles', { count: failedCount })}</p>
            )}
            <div className="flex max-h-96 flex-col overflow-y-auto">
              {tasks.map((task) => {
                const pct = task.size > 0 ? Math.round((task.received / task.size) * 100) : 0;
                return (
                  <div
                    key={task.key}
                    className="flex flex-col gap-1 border-b border-zinc-100 py-2 text-sm last:border-b-0 dark:border-zinc-800"
                    title={task.error || task.path}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-72 min-w-0 truncate text-zinc-600 dark:text-zinc-300">{task.name}</span>
                      <span className="hidden text-xs text-zinc-400 lg:block">{task.sourceId}</span>
                      <span className="ml-auto shrink-0 text-xs text-zinc-400">
                        {formatBytes(task.received)} / {formatBytes(task.size)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Progress
                        value={task.status === 'done' ? 100 : task.status === 'failed' ? 100 : pct}
                        className={cn(
                          'h-1.5',
                          task.status === 'failed' && '[&>div]:bg-[#DC2626]',
                          task.status === 'done' && '[&>div]:bg-[#16A34A]',
                        )}
                      />
                      <span
                        className={cn(
                          'w-20 shrink-0 text-right text-xs',
                          task.status === 'failed'
                            ? 'text-[#DC2626]'
                            : task.status === 'done'
                              ? 'text-[#16A34A]'
                              : 'text-zinc-500 dark:text-zinc-400',
                        )}
                      >
                        {task.status === 'downloading' || task.status === 'pending'
                          ? `${pct}%`
                          : statusLabel(task.status, t)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function totalDownloaded(tasks: DownloadTask[]): number {
  return tasks.reduce((sum, x) => sum + x.received, 0);
}
