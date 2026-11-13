// 服务器配置：仅从 1B1T mirror 读取 servers/index.json（不降级到备用/官方源）
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { httpDownload } from './http';
import { getServerSource } from './sources';
import type { ServerIndex } from './types';

/** 拉取服务器索引；镜像不可达时按需求直接报「服务器配置源无法访问」 */
export async function fetchServerIndex(): Promise<ServerIndex> {
  const source = getServerSource();
  const url = `${source.baseUrl.replace(/\/+$/, '')}/servers/index.json`;
  const tmp = path.join(os.tmpdir(), `mcore-server-index-${process.pid}.json`);
  try {
    const r = await httpDownload(url, tmp, { timeoutMs: 10000 });
    if (!r.ok) {
      throw new Error(`服务器配置源无法访问（${source.name}：${r.error}）`);
    }
    const raw = fs.readFileSync(tmp, 'utf-8');
    const parsed = JSON.parse(raw) as ServerIndex;
    if (!parsed || !Array.isArray(parsed.servers)) {
      throw new Error('服务器配置源数据格式异常');
    }
    return parsed;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}
