// 生成主页壁纸：MC 草方块像素纹理铺满 + 暗化处理（纯代码，无外部素材）
// 用法：node scripts/gen-wallpaper.mjs → src/assets/wallpaper.png (1920x1080)
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const W = 1920;
const H = 1080;
const TILE = 64; // 每格 64px 的草方块

// ---- PNG 编码（同 gen-icons）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 像素绘制：确定性噪声 ----
function noise(x, y, salt) {
  let n = (x * 374761393 + y * 668265263 + salt * 1442695040888963407) >>> 0;
  n = (n ^ (n >> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

// 草皮与泥土基准色
const GRASS = { r: 0x7a, g: 0xa8, b: 0x45 };
const DIRT = { r: 0x86, g: 0x66, b: 0x47 };

const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  const ty = y % TILE;
  // 过渡带占比：草皮上沿 0-0.16，渐变 0.16-0.34，泥土 0.34-1
  const t = ty / TILE;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // 草→泥的平滑渐变系数（无硬行，避免条纹）
    let mix;
    if (t < 0.16) mix = 1;
    else if (t > 0.34) mix = 0;
    else mix = (0.34 - t) / (0.34 - 0.16);
    mix = Math.round(mix * 10) / 10; // 微量化，形成柔和的层理而非条纹

    // 每像素独立噪点（细腻颗粒感）
    const n = (noise(x, y, 1) - 0.5) * 0.16;
    let r = GRASS.r * mix + DIRT.r * (1 - mix);
    let g = GRASS.g * mix + DIRT.g * (1 - mix);
    let b = GRASS.b * mix + DIRT.b * (1 - mix);
    r += r * n; g += g * n; b += b * n;

    // 泥土区域随机小石粒与深斑
    if (mix === 0) {
      if (noise(x, y, 5) < 0.05) { r += 22; g += 22; b += 20; }
      if (noise(x, y, 6) < 0.04) { r -= 28; g -= 26; b -= 22; }
    }
    // 默认纯黑背景（无纹理）
    rgba[i] = 10;
    rgba[i + 1] = 10;
    rgba[i + 2] = 10;
    rgba[i + 3] = 255;
  }
}

const out = path.resolve(import.meta.dirname, '../src/assets/wallpaper.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(W, H, rgba));
console.log(`壁纸已生成: ${out} (${W}x${H})`);
