#!/usr/bin/env node
// 把 electron/ 下的静态资源复制进 dist-electron（tsc 不处理非 TS 文件）
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const from = path.join(root, 'electron', 'splash.html');
const to = path.join(root, 'dist-electron', 'splash.html');
if (!fs.existsSync(from)) {
  console.error('[copy-assets] 缺少 electron/splash.html');
  process.exit(1);
}
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.copyFileSync(from, to);
console.log('[copy-assets] splash.html → dist-electron/');
