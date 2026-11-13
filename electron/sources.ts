// 资源源管理：自动/手动模式源链、bmclapi 协议 URL 映射
import { getMirrors, getSettings } from './config';
import type { SourceDef } from './types';

/** 当前模式下可用的客户端源链（按优先级排序） */
export function getClientSourceChain(): SourceDef[] {
  const mirrors = getMirrors();
  const settings = getSettings();
  const enabled = mirrors.clientSources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority);

  if (settings.sourceMode === 'manual') {
    // 手动模式：仅用户选中那一个源，不存在则回退第一个启用源
    const picked = enabled.find((s) => s.id === settings.manualSourceId) ?? enabled[0];
    return picked ? [picked] : [];
  }
  return enabled;
}

/** 服务器文件源（仅 1B1T） */
export function getServerSource(): SourceDef {
  return getMirrors().serverSource;
}

/** 探测/测速用的 URL：新版 BMCLAPI 与 Mojang piston-meta 同构，均为 /mc/game/version_manifest_v2.json（旧路径 /version_manifest_v2.json 已 404） */
export function probeUrl(source: SourceDef): string {
  return `${source.baseUrl}/mc/game/version_manifest_v2.json`;
}

/** bmclapi 协议各类资源 URL 映射（bmclapi2 新版路径，2026-10 实测） */
export function bmclapiUrl(source: SourceDef, kind: string, arg1: string, arg2 = ''): string {
  const base = source.baseUrl.replace(/\/+$/, '');
  switch (kind) {
    case 'manifest':
      return `${base}/mc/game/version_manifest_v2.json`;
    case 'versionJson':
      return `${base}/version/${arg1}/json`;
    case 'clientJar':
      return `${base}/version/${arg1}/client`;
    case 'library':
      return `${base}/libraries/${arg1}`;
    case 'asset':
      return `${base}/assets/${arg1}/${arg2}`;
    case 'assetIndex':
      // 新版 BMCLAPI 与 Mojang piston-meta 同构：/v1/packages/<hash>/<name>.json
      return arg2 ? `${base}/v1/packages/${arg1}/${arg2}` : '';
    default:
      return '';
  }
}
