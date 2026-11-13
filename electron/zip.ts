// 最小 zip 解压：仅用于提取 natives jar 内的平台原生库（支持 store/deflate）
// 实现依据 zip 规范（EOCD + Central Directory + Local Header）
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

function readU16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function readU32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/**
 * 解压 zip 内全部文件到 destDir。
 * @param exclude 排除前缀列表（如 ['META-INF/']），extract.exclude 字段
 */
export function extractZip(zipPath: string, destDir: string, exclude: string[] = []): void {
  const buf = fs.readFileSync(zipPath);
  if (buf.length < 22) return;

  // 1. 定位 EOCD（签名 0x06054b50，从尾部向前扫描）
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanStart; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return;

  const entryCount = readU16(buf, eocd + 10);
  let cursor = readU32(buf, eocd + 16); // central directory offset

  const destAbs = path.resolve(destDir);
  fs.mkdirSync(destAbs, { recursive: true });

  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) break; // central header 签名不符则停止
    const method = readU16(buf, cursor + 10);
    const compressedSize = readU32(buf, cursor + 20);
    const nameLen = readU16(buf, cursor + 28);
    const extraLen = readU16(buf, cursor + 30);
    const commentLen = readU16(buf, cursor + 32);
    const localOffset = readU32(buf, cursor + 42);
    const name = buf.toString('utf-8', cursor + 46, cursor + 46 + nameLen);

    cursor += 46 + nameLen + extraLen + commentLen;

    // 目录项或排除项跳过
    if (name.endsWith('/') || name.endsWith('\\')) continue;
    if (exclude.some((e) => name.startsWith(e))) continue;

    // 防路径穿越
    const target = path.resolve(destAbs, name);
    if (!target.startsWith(destAbs + path.sep)) continue;

    // 读 local header 获取数据偏移
    if (localOffset + 30 > buf.length) continue;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = readU16(buf, localOffset + 26);
    const lExtraLen = readU16(buf, localOffset + 28);
    const dataOffset = localOffset + 30 + lNameLen + lExtraLen;
    if (dataOffset + compressedSize > buf.length) continue;

    const raw = buf.subarray(dataOffset, dataOffset + compressedSize);
    let content: Buffer;
    if (method === 0) {
      content = raw;
    } else if (method === 8) {
      try {
        content = zlib.inflateRawSync(raw);
      } catch {
        continue;
      }
    } else {
      continue; // 不支持的压缩方法
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
