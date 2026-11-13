// 下载队列：多文件并发、断点续传、SHA1 校验、失败重试、源自动切换
import * as fs from 'fs';
import * as crypto from 'crypto';
import { httpDownload } from './http';
import type { DownloadTask } from './types';

/** 下载参数（用户确认值） */
const CONCURRENCY = 8; // 文件级并发
const MAX_RETRY_SAME_SOURCE = 3; // 同源网络失败重试次数
const TIMEOUT_MS = 10000; // 连接超时
const MIN_SPEED_BPS = 256 * 1024; // 慢速阈值 256KB/s

/** 资源文件描述（候选 URL 按源优先级排列） */
export interface ResourceFile {
  key: string;
  name: string;
  /** 最终文件路径（相对游戏目录或绝对） */
  path: string;
  /** 候选下载地址，按优先级顺序 */
  candidates: { sourceId: string; url: string }[];
  /** 期望 SHA1，空=不校验 */
  sha1: string;
  /** 期望大小（字节），0=未知 */
  size: number;
}

export interface DownloadCallbacks {
  onProgress: (task: DownloadTask, doneCount: number, totalCount: number) => void;
  /** 返回 true 表示取消 */
  shouldAbort?: () => boolean;
}

/** 计算文件 SHA256（更新包完整性校验用） */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (d: Buffer) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', () => resolve(''));
  });
}

/** 计算文件 SHA1 */
export function sha1File(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha1');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (d: Buffer) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', () => resolve(''));
  });
}

function partPath(p: string): string {
  return `${p}.part`;
}

/** 检查最终文件是否已完整（大小+哈希都匹配才视为完成） */
async function isComplete(f: ResourceFile): Promise<boolean> {
  try {
    const st = fs.statSync(f.path);
    if (f.size > 0 && st.size !== f.size) return false;
    if (f.sha1) {
      return (await sha1File(f.path)) === f.sha1;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 下载全部资源。
 * 每文件流程：已完整→跳过；.part 存在→续传；下载→校验；失败→同源重试→换源→全源失败报错
 */
export async function runDownloads(
  files: ResourceFile[],
  cb: DownloadCallbacks,
): Promise<{ done: string[]; failed: DownloadTask[] }> {
  const total = files.length;
  const doneSet = new Set<string>();
  const failedList: DownloadTask[] = [];
  let nextIndex = 0;

  const tasks = new Map<string, DownloadTask>();
  const report = (t: DownloadTask) => {
    tasks.set(t.key, t);
    cb.onProgress(t, doneSet.size, total);
  };

  const worker = async () => {
    // 外层循环取任务
    for (;;) {
      if (cb.shouldAbort?.()) return;
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= total) return;
      const f = files[idx];
      const task: DownloadTask = {
        key: f.key,
        name: f.name,
        path: f.path,
        url: f.candidates[0]?.url ?? '',
        size: f.size,
        sha1: f.sha1,
        status: 'pending',
        received: 0,
        sourceId: f.candidates[0]?.sourceId ?? '',
        error: '',
      };
      report(task);

      // 1. 已完整 → 跳过
      if (await isComplete(f)) {
        task.status = 'done';
        task.received = f.size || fs.statSync(f.path).size;
        doneSet.add(f.key);
        report(task);
        continue;
      }

      // 2. 依候选源顺序尝试
      let success = false;
      for (const cand of f.candidates) {
        if (cb.shouldAbort?.()) break;
        task.sourceId = cand.sourceId;
        task.url = cand.url;
        task.status = 'downloading';

        // 同源重试
        for (let attempt = 0; attempt < MAX_RETRY_SAME_SOURCE; attempt += 1) {
          if (cb.shouldAbort?.()) break;
          const pp = partPath(f.path);
          let resumeFrom = 0;
          try {
            if (fs.existsSync(pp)) resumeFrom = fs.statSync(pp).size;
          } catch {
            resumeFrom = 0;
          }
          // 最终文件不完整但存在 → 删除（内容损坏场景）
          try {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
          } catch {
            // 忽略
          }

          task.received = resumeFrom;
          report(task);

          const r = await httpDownload(cand.url, pp, {
            resumeFrom,
            expectedSize: f.size,
            timeoutMs: TIMEOUT_MS,
            minSpeedBps: MIN_SPEED_BPS,
            onProgress: (received, totalSize) => {
              task.received = received;
              if (totalSize > 0) task.size = totalSize;
              report(task);
            },
            signal: { get aborted() { return cb.shouldAbort?.() ?? false; } },
          });

          if (cb.shouldAbort?.()) break;

          if (r.ok) {
            // SHA1 校验
            task.status = 'verify';
            report(task);
            let hashOk = true;
            if (f.sha1) {
              const h = await sha1File(pp);
              hashOk = h === f.sha1;
              if (!hashOk) {
                try {
                  fs.unlinkSync(pp);
                } catch {
                  // 忽略
                }
                task.error = 'SHA1 校验失败，重新下载';
                task.status = 'downloading';
                task.received = 0;
                report(task);
                continue; // 同源重试（重新下载）
              }
            }
            if (hashOk) {
              try {
                fs.renameSync(pp, f.path);
              } catch {
                fs.copyFileSync(pp, f.path);
                fs.unlinkSync(pp);
              }
              task.status = 'done';
              task.received = r.received;
              if (r.total > 0) task.size = r.total;
              doneSet.add(f.key);
              report(task);
              success = true;
              break;
            }
          } else {
            task.error = r.error;
            if (r.slow) {
              // 慢速不重试，直接换源（保留 .part 供新源续传）
              break;
            }
            task.received = resumeFrom;
            report(task);
            // 网络错误 → 同源重试
          }
        }
        if (success || cb.shouldAbort?.()) break;
      }

      if (!success && !cb.shouldAbort?.()) {
        task.status = 'failed';
        task.error = task.error || '全部资源源均不可用';
        failedList.push({ ...task });
        report(task);
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CONCURRENCY, total); i += 1) workers.push(worker());
  await Promise.all(workers);

  return { done: Array.from(doneSet), failed: failedList };
}

/** 清理某个资源的 .part 残留 */
export function cleanPart(p: string): void {
  try {
    if (fs.existsSync(partPath(p))) fs.unlinkSync(partPath(p));
  } catch {
    // 忽略
  }
}

export { partPath };
