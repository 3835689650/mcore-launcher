// 资源源连通性测速：HEAD 探活（5s）+ manifest 实测（均速 ≥256KB/s 判可用）
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { httpDownload, httpHead } from './http';
import { probeUrl } from './sources';
import type { SourceDef, SourceTestResult } from './types';

const HEAD_TIMEOUT_MS = 5000;
// 测速以连通性为主：128KB/s 即可判可用（下载中途的慢速阈值仍为 256KB/s）
const MIN_SPEED_BPS = 128 * 1024;
const MAX_TEST_BYTES = 512 * 1024; // 最多测 512KB
const CACHE_TTL_MS = 60000; // 测速结果缓存（防止连点触发镜像站频控）

/** 实测 manifest 下载速度（复用 httpDownload：支持重定向/Range/速度统计） */
async function measureSpeed(url: string): Promise<{ speedKBs: number; bytes: number; error: string }> {
  const tmp = path.join(os.tmpdir(), `mcore-speedtest-${process.pid}-${Date.now()}.json`);
  const start = Date.now();
  let received = 0;
  const signal = { aborted: false };
  try {
    const r = await httpDownload(url, tmp, {
      timeoutMs: 10000,
      onProgress: (recv) => {
        received = recv;
        if (recv >= MAX_TEST_BYTES) signal.aborted = true;
      },
      signal,
    });
    const secs = (Date.now() - start) / 1000;
    const speedKBs = Math.round(received / 1024 / Math.max(secs, 0.01));
    // 主动中止（测满 512KB）与慢速中止都拿到了真实速度；网络错误才报错
    if (!r.ok && !r.slow && r.error !== '已取消') {
      return { speedKBs: 0, bytes: received, error: r.error };
    }
    return { speedKBs, bytes: received, error: '' };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

const cache = new Map<string, { at: number; result: SourceTestResult }>();

/** 测试单个源：HEAD 快速探活 + manifest 实测。部分 CDN 对 HEAD 间歇 404，以 GET 实测为准 */
export async function testSource(source: SourceDef): Promise<SourceTestResult> {
  const hit = cache.get(source.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const url = probeUrl(source);
  const head = await httpHead(url, HEAD_TIMEOUT_MS);
  const speed = await measureSpeed(url);
  // 完整收到但总量 <8KB：文件太小无法测速，按可达判可用
  const tooSmall = speed.bytes > 0 && speed.bytes < 8 * 1024;
  const ok = tooSmall || speed.speedKBs >= MIN_SPEED_BPS / 1024;
  const error = ok ? '' : speed.error || head.error || (head.ok ? '速度不达标' : `HTTP ${head.status}`);
  const result: SourceTestResult = {
    sourceId: source.id,
    name: source.name,
    ok,
    speedKBs: speed.speedKBs,
    latencyMs: head.latencyMs,
    error,
  };
  // 仅成功结果进缓存；失败不缓存，否则重试会命中失败缓存导致重试失效
  if (ok) cache.set(source.id, { at: Date.now(), result });
  return result;
}

/** 测试全部客户端源（串行：避免镜像站对并发请求的频控误判 404） */
export async function testAllSources(sources: SourceDef[]): Promise<SourceTestResult[]> {
  const out: SourceTestResult[] = [];
  for (const s of sources) {
    let r = await testSource(s);
    // 404/限流瞬时失败重试一次（镜像站频控间歇 404）
    if (!r.ok) {
      await new Promise((res) => setTimeout(res, 800));
      const again = await testSource(s);
      if (again.ok) r = again;
    }
    out.push(r);
  }
  return out;
}
