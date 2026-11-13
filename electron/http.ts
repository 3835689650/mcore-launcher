// 底层 HTTP 客户端：HEAD 探活、流式下载（Range 断点、超时、慢速检测、中止）
// 独立成模块便于单元自测
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

export interface HeadResult {
  ok: boolean;
  status: number;
  headers: http.IncomingHttpHeaders;
  latencyMs: number;
  error: string;
}

export interface DownloadResult {
  ok: boolean;
  status: number;
  /** 本次实际接收字节数 */
  received: number;
  /** 文件总大小（字节），未知为 0 */
  total: number;
  /** 服务端支持 Range */
  rangeSupported: boolean;
  error: string;
  /** 因慢速被中止 */
  slow: boolean;
}

const MAX_REDIRECTS = 5;

function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

function doRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  redirectsLeft: number,
  timeoutMs: number,
): Promise<{ res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const u = parseUrl(url);
    if (!u) {
      reject(new Error(`无效 URL: ${url}`));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, headers, timeout: timeoutMs },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`重定向次数超限: ${url}`));
            return;
          }
          const next = new URL(res.headers.location, u).toString();
          doRequest(next, method, headers, redirectsLeft - 1, timeoutMs)
            .then(resolve)
            .catch(reject);
          return;
        }
        resolve({ res });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`连接超时 ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

/** HEAD 探活：返回状态码与延迟 */
export async function httpHead(url: string, timeoutMs = 5000): Promise<HeadResult> {
  const start = Date.now();
  try {
    const { res } = await doRequest(url, 'HEAD', { 'User-Agent': 'MCore-Launcher/1.0' }, MAX_REDIRECTS, timeoutMs);
    const latency = Date.now() - start;
    res.resume();
    return { ok: res.statusCode === 200, status: res.statusCode ?? 0, headers: res.headers, latencyMs: latency, error: '' };
  } catch (e) {
    return { ok: false, status: 0, headers: {}, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 流式下载到文件。
 * - resumeFrom: 已有字节数，>0 时带 Range 请求断点续传；服务端忽略 Range（返回 200）则截断重下
 * - minSpeedBps: 慢速阈值，5 秒窗口均速低于该值且未完成 → 中止并标记 slow
 * - onProgress: 周期性回调
 * - signal: 外部中止
 */
export function httpDownload(
  url: string,
  destPath: string,
  opts: {
    resumeFrom?: number;
    expectedSize?: number;
    timeoutMs?: number;
    minSpeedBps?: number;
    onProgress?: (received: number, total: number) => void;
    signal?: { aborted: boolean };
  },
): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const minSpeed = opts.minSpeedBps ?? 0;
  const resumeFrom = opts.resumeFrom ?? 0;

  return new Promise((resolve) => {
    const headers: Record<string, string> = { 'User-Agent': 'MCore-Launcher/1.0' };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    doRequest(url, 'GET', headers, MAX_REDIRECTS, timeoutMs)
      .then(({ res }) => {
        const code = res.statusCode ?? 0;
        const rangeSupported = code === 206;
        if (code !== 200 && code !== 206) {
          res.resume();
          resolve({ ok: false, status: code, received: 0, total: 0, rangeSupported, error: `HTTP ${code}`, slow: false });
          return;
        }

        const totalFromHeader = Number(res.headers['content-length'] ?? 0) || 0;
        const total = (rangeSupported ? resumeFrom + totalFromHeader : totalFromHeader) || opts.expectedSize || 0;
        // 服务端忽略 Range（200）：截断重下；支持则追加续传
        const startOffset = rangeSupported ? resumeFrom : 0;
        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
        } catch {
          // 目录已存在等情况忽略
        }
        const ws = fs.createWriteStream(destPath, { flags: startOffset > 0 ? 'a' : 'w' });

        let received = 0;
        let windowStart = Date.now();
        let windowBytes = 0;
        let finished = false;
        let abortTimer: NodeJS.Timeout | null = null;

        const finish = (r: DownloadResult) => {
          if (finished) return;
          finished = true;
          if (abortTimer) clearInterval(abortTimer);
          res.destroy();
          ws.end(() => resolve(r));
        };

        const onChunk = (chunk: Buffer) => {
          received += chunk.length;
          windowBytes += chunk.length;
          opts.onProgress?.(startOffset + received, total);
          const elapsed = Date.now() - windowStart;
          if (elapsed >= 5000) {
            if (minSpeed > 0 && windowBytes < minSpeed * 5) {
              finish({ ok: false, status: code, received: startOffset + received, total, rangeSupported, error: '下载速度过慢', slow: true });
              return;
            }
            windowStart = Date.now();
            windowBytes = 0;
          }
        };

        res.on('data', onChunk);
        res.on('end', () => finish({ ok: true, status: code, received: startOffset + received, total, rangeSupported, error: '', slow: false }));
        res.on('error', (e) => finish({ ok: false, status: code, received: startOffset + received, total, rangeSupported, error: e.message, slow: false }));
        res.on('aborted', () => finish({ ok: false, status: code, received: startOffset + received, total, rangeSupported, error: '连接中断', slow: false }));
        ws.on('error', (e) => finish({ ok: false, status: code, received: startOffset + received, total, rangeSupported, error: `写入失败: ${e.message}`, slow: false }));

        res.pipe(ws);

        abortTimer = setInterval(() => {
          if (opts.signal?.aborted) {
            finish({ ok: false, status: code, received: startOffset + received, total, rangeSupported, error: '已取消', slow: false });
          }
        }, 200);
      })
      .catch((e) => {
        resolve({ ok: false, status: 0, received: 0, total: 0, rangeSupported: false, error: e instanceof Error ? e.message : String(e), slow: false });
      });
  });
}
