// Java 运行时探测：环境变量 + PATH + 常见安装路径 + Windows 注册表；缺失时自动安装（TUNA Adoptium 镜像）
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { app } from 'electron';
import { httpDownload } from './http';
import { extractZip } from './zip';
import { getSettings } from './config';
import type { JavaRuntime } from './types';

const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const PROBE_TIMEOUT_MS = 5000;

/** 读取 java -version 输出并解析主版本号（输出在 stderr） */
function probeVersion(javaPath: string, source: string): Promise<JavaRuntime | null> {
  return new Promise((resolve) => {
    // 先确认候选是存在的可执行文件，避免 PATH 中的非目录条目导致 spawn ENOTDIR
    try {
      const st = fs.statSync(javaPath);
      if (!st.isFile()) {
        resolve(null);
        return;
      }
    } catch {
      resolve(null);
      return;
    }
    execFile(javaPath, ['-version'], { timeout: PROBE_TIMEOUT_MS }, (err, _stdout, stderr) => {
      const out = `${_stdout}\n${stderr}`;
      const m = out.match(/version "([^"]+)"/);
      if (!m) {
        resolve(null);
        return;
      }
      const ver = m[1];
      // "1.8.0_392" → 8；"21.0.12" → 21
      let major = 0;
      if (ver.startsWith('1.')) {
        major = Number(ver.split('.')[1] ?? 0) || 0;
      } else {
        major = Number(ver.split('.')[0] ?? 0) || 0;
      }
      if (err && major === 0) {
        resolve(null);
        return;
      }
      resolve({ path: javaPath, version: ver, major, source });
    });
  });
}

/** 收集候选 java 路径（平台相关） */
function collectCandidates(): string[] {
  const out: string[] = [];
  const home = os.homedir();

  // 手动指定（最高优先，由调用方先验证）
  const manual = getSettings().javaPath?.trim();
  if (manual) out.push(manual);

  // 启动器自动安装的 JDK（userData/jre/<major>/<jdk目录>/bin/java）
  try {
    const jreRoot = path.join(app.getPath('userData'), 'jre');
    for (const major of fs.readdirSync(jreRoot)) {
      for (const sub of fs.readdirSync(path.join(jreRoot, major))) {
        out.push(path.join(jreRoot, major, sub, 'bin', JAVA_EXE));
      }
    }
  } catch {
    // 尚未自动安装过
  }

  // JAVA_HOME
  if (process.env.JAVA_HOME) out.push(path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE));

  // PATH 中的 java
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of pathDirs) out.push(path.join(d, JAVA_EXE));

  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files (x86)\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto',
    ];
    for (const root of roots) {
      try {
        for (const sub of fs.readdirSync(root)) {
          out.push(path.join(root, sub, 'bin', JAVA_EXE));
        }
      } catch {
        // 目录不存在，跳过
      }
    }
  } else if (process.platform === 'darwin') {
    const roots = [
      '/Library/Java/JavaVirtualMachines',
      '/System/Library/Java/JavaVirtualMachines',
      path.join(home, 'Library/Java/JavaVirtualMachines'),
    ];
    for (const root of roots) {
      try {
        for (const sub of fs.readdirSync(root)) {
          out.push(path.join(root, sub, 'Contents/Home/bin', JAVA_EXE));
        }
      } catch {
        // 跳过
      }
    }
  } else {
    // Linux
    out.push('/usr/bin/java');
    try {
      for (const sub of fs.readdirSync('/usr/lib/jvm')) {
        out.push(path.join('/usr/lib/jvm', sub, 'bin', JAVA_EXE));
      }
    } catch {
      // 跳过
    }
  }
  return out;
}

/** 从 Windows 注册表读取 Java 安装位置（仅 Windows） */
function registryCandidates(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
    'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Development Kit',
  ];
  return new Promise((resolve) => {
    let out: string[] = [];
    let pending = keys.length;
    if (pending === 0) resolve(out);
    for (const key of keys) {
      execFile(
        'reg',
        ['query', key, '/s', '/v', 'JavaHome'],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (!err && stdout) {
            const lines = stdout.split(/\r?\n/);
            for (const line of lines) {
              const m = line.match(/JavaHome\s+REG_SZ\s+(.+)$/i);
              if (m && m[1]) out.push(path.join(m[1].trim(), 'bin', JAVA_EXE));
            }
          }
          pending -= 1;
          if (pending === 0) resolve(out);
        },
      );
    }
  });
}

/** 扫描结果缓存（每次启动都全量扫描 + 逐个 java -version 太慢） */
let scanCache: { at: number; manual: string; list: JavaRuntime[] } | null = null;
const SCAN_TTL_MS = 60_000;

/** 全渠道扫描本机 Java，去重并验证可用（结果缓存 60s；force=true 强制重扫） */
export async function scanJava(force = false): Promise<JavaRuntime[]> {
  const manual = getSettings().javaPath?.trim() ?? '';
  if (!force && scanCache && scanCache.manual === manual && Date.now() - scanCache.at < SCAN_TTL_MS) {
    return scanCache.list;
  }
  const raw: string[] = [];
  const seen = new Set<string>();
  for (const c of collectCandidates()) {
    const norm = c.trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    raw.push(norm);
  }
  for (const c of await registryCandidates()) {
    const norm = c.trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    raw.push(norm);
  }

  const found: JavaRuntime[] = [];
  const seenPath = new Set<string>();
  for (const c of raw) {
    if (seenPath.has(c)) continue;
    seenPath.add(c);
    let source = 'PATH';
    if (process.env.JAVA_HOME && c.startsWith(process.env.JAVA_HOME)) source = 'JAVA_HOME';
    else if (c === getSettings().javaPath?.trim()) source = '手动指定';
    else if (c.includes('jvm') || c.includes('Java')) source = '扫描发现';
    const r = await probeVersion(c, source);
    if (r) found.push(r);
  }
  scanCache = { at: Date.now(), manual, list: found };
  return found;
}

/**
 * 版本匹配：优先 version.json 的 javaVersion.majorVersion；
 * 缺失时按版本号区间兜底（1.21.x→21 / 1.20.5+→21 / 1.18-1.20.4→17 / 1.17→16 / ≤1.16.5→8）
 */
export function requiredJavaMajor(versionId: string, javaMajorField: number | undefined): number {
  if (typeof javaMajorField === 'number' && javaMajorField > 0) return javaMajorField;
  const m = versionId.match(/^(\d+)\.(\d+)/);
  if (!m) return 8;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 1) return a >= 26 ? 25 : 21;
  if (a === 1 && b >= 26) return 25; // 1.26 起需要 Java 25
  if (a === 1 && b >= 20) return 21;
  if (a === 1 && b >= 18) return 17;
  if (a === 1 && b >= 17) return 16;
  return 8;
}

/**
 * 从探测列表挑选匹配的 Java：精确 major 优先；
 * 1.17+ 允许使用更高版本，旧版本（≤1.16 需 Java 8）必须精确，否则游戏会直接崩溃。
 */
export function pickJava(runtimes: JavaRuntime[], requiredMajor: number): JavaRuntime | null {
  const exact = runtimes.find((r) => r.major === requiredMajor);
  if (exact) return exact;
  if (requiredMajor < 16) return null;
  const higher = runtimes.filter((r) => r.major > requiredMajor).sort((x, y) => x.major - y.major);
  return higher[0] ?? null;
}

/** 最小 tar.gz 解压（Adoptium JDK 包）：跳过符号链接，仅提取常规文件 */
function extractTarGz(gzPath: string, destDir: string): void {
  const buf = zlib.gunzipSync(fs.readFileSync(gzPath));
  let off = 0;
  let guard = 0;
  while (off + 512 <= buf.length && guard < 100000) {
    guard += 1;
    const name = buf.toString('utf-8', off, off + 100).replace(/\0[\s\S]*$/, '');
    const sizeStr = buf.toString('utf-8', off + 124, off + 136).replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const modeStr = buf.toString('utf-8', off + 100, off + 108).replace(/\0[\s\S]*$/, '').trim();
    const mode = parseInt(modeStr, 8) || 0o755;
    const type = buf[off + 156];
    if (!name) break;
    const target = path.join(destDir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === 0x30 || type === 0) {
      // 常规文件（恢复权限位，bin/java 等必须可执行）
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf.subarray(off + 512, off + 512 + size));
      try {
        fs.chmodSync(target, mode);
      } catch {
        // 忽略
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

/** TUNA Adoptium 镜像：拉取目录列表解析最新 JDK 文件名 */
async function fetchJdkFileName(major: number, arch: string, osKey: string): Promise<string> {
  const listingUrl = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jdk/${arch}/${osKey}/`;
  const tmp = path.join(os.tmpdir(), `mcore-jdk-list-${process.pid}-${Date.now()}.html`);
  try {
    const r = await httpDownload(listingUrl, tmp, { timeoutMs: 15000 });
    if (!r.ok) return '';
    const html = fs.readFileSync(tmp, 'utf-8');
    const ext = osKey === 'windows' ? 'zip' : 'tar.gz';
    const re = new RegExp(`OpenJDK${major}U-jdk_${arch}_${osKey}_hotspot_[^"<>]+?\\.${ext.replace('.', '\\.')}`, 'g');
    const names = Array.from(html.matchAll(re), (m) => m[0]);
    // 排除 debugimage/testimage，取最后一个（TUNA 列表按版本排列）
    const cleaned = names.filter((n) => !n.includes('debugimage') && !n.includes('testimage'));
    return cleaned[cleaned.length - 1] ?? '';
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

/**
 * 自动安装 JDK（TUNA Adoptium 镜像）到 userData/jre/<major>/，返回可用的 JavaRuntime
 */
export async function downloadJava(
  major: number,
  onProgress?: (msg: string) => void,
): Promise<JavaRuntime | null> {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
  const osKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const baseUrl = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jdk/${arch}/${osKey}`;

  onProgress?.(`正在获取 Java ${major} 版本列表…`);
  const fileName = await fetchJdkFileName(major, arch, osKey);
  if (!fileName) {
    onProgress?.(`获取 Java ${major} 版本列表失败`);
    return null;
  }
  onProgress?.(`下载 ${fileName}…`);

  const jreRoot = path.join(app.getPath('userData'), 'jre');
  const pkgPath = path.join(os.tmpdir(), `mcore-jdk-${process.pid}-${Date.now()}-${fileName}`);
  try {
    const r = await httpDownload(`${baseUrl}/${fileName}`, pkgPath, { timeoutMs: 30000 });
    if (!r.ok) {
      onProgress?.(`下载失败: ${r.error}`);
      return null;
    }
    onProgress?.(`解压部署…`);
    const dest = path.join(jreRoot, String(major));
    fs.mkdirSync(dest, { recursive: true });
    if (fileName.endsWith('.zip')) {
      extractZip(pkgPath, dest, []);
    } else {
      extractTarGz(pkgPath, dest);
    }
    // JDK 目录名如 jdk-21.0.5+11，找 bin/java
    const candidates: string[] = [];
    for (const sub of fs.readdirSync(dest)) {
      candidates.push(path.join(dest, sub, 'bin', JAVA_EXE));
    }
    for (const c of candidates) {
      const rt = await probeVersion(c, '自动安装');
      if (rt) return rt;
    }
    onProgress?.(`解压完成但未找到 java 可执行文件`);
    return null;
  } finally {
    try {
      fs.unlinkSync(pkgPath);
    } catch {
      // 忽略
    }
  }
}
