// 生成应用图标：蓝底圆角方块 + 白色像素 M（纯代码生成，无外部素材）
// 用法：node scripts/gen-icons.mjs → resources/icon.png (512x512) + resources/tray.png (32x32)
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'resources');
fs.mkdirSync(outDir, { recursive: true });

// ---- PNG 编码 ----
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 绘制 ----
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const corner = Math.round(size * 0.22); // 圆角半径

  // 圆角检测
  const inRound = (x, y) => {
    const dx = x < corner ? corner - x : x >= size - corner ? x - (size - corner - 1) : 0;
    const dy = y < corner ? corner - y : y >= size - corner ? y - (size - corner - 1) : 0;
    if (dx <= 0 && dy <= 0) return true;
    return dx * dx + dy * dy <= corner * corner;
  };

  // M 点阵（5x7，每个单元占位比例）
  const M = [
    [1, 0, 0, 0, 1],
    [1, 1, 0, 1, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ];
  const cols = 5;
  const rows = 7;
  const cell = Math.floor(size * 0.1);
  const totalW = cols * cell + (cols - 1) * Math.floor(cell * 0.35);
  const totalH = rows * cell + (rows - 1) * Math.floor(cell * 0.35);
  const offX = Math.floor((size - totalW) / 2);
  const offY = Math.floor((size - totalH) / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRound(x, y)) {
        rgba[i + 3] = 0; // 透明
        continue;
      }
      // 背景 #2563EB
      rgba[i] = 0x25;
      rgba[i + 1] = 0x63;
      rgba[i + 2] = 0xeb;
      rgba[i + 3] = 255;
      // M 白色像素
      const mx = Math.floor((x - offX) / (cell + Math.floor(cell * 0.35)));
      const my = Math.floor((y - offY) / (cell + Math.floor(cell * 0.35)));
      const inCellX = x - offX - mx * (cell + Math.floor(cell * 0.35));
      const inCellY = y - offY - my * (cell + Math.floor(cell * 0.35));
      if (
        mx >= 0 && mx < cols && my >= 0 && my < rows &&
        M[my][mx] === 1 && inCellX < cell && inCellY < cell
      ) {
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
      }
    }
  }
  return encodePng(size, size, rgba);
}

fs.writeFileSync(path.join(outDir, 'icon.png'), drawIcon(512));
fs.writeFileSync(path.join(outDir, 'tray.png'), drawIcon(32));
console.log('图标已生成: resources/icon.png (512) + resources/tray.png (32)');
