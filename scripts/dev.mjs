// 开发模式：编译主进程 → 启动 vite → 启动 electron
// 用法：npm run dev
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

const root = path.resolve(import.meta.dirname, '..');
const PORT = 5173;

// 1. 编译主进程（一次性；主进程改动后重启 npm run dev）
console.log('[dev] 编译主进程…');
execSync('npx tsc -p tsconfig.electron.json', { cwd: root, stdio: 'inherit' });
execSync('node scripts/copy-assets.mjs', { cwd: root, stdio: 'inherit' });

// 2. 启动 vite
console.log('[dev] 启动 vite…');
const vite = spawn('npx', ['vite'], { cwd: root, stdio: 'inherit' });

function waitServer(url, tries = 60) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      n += 1;
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (n >= tries) reject(new Error('vite 启动超时'));
          else setTimeout(tick, 500);
        });
    };
    tick();
  });
}

// 3. 等 vite 就绪后启动 electron
waitServer(`http://localhost:${PORT}/`)
  .then(() => {
    console.log('[dev] 启动 electron…');
    const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const electron = spawn(electronBin, ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, MCORE_DEV_URL: `http://localhost:${PORT}` },
    });
    electron.on('exit', (code) => {
      console.log(`[dev] electron 退出（code=${code}）`);
      vite.kill();
      process.exit(code ?? 0);
    });
  })
  .catch((e) => {
    console.error('[dev] 失败:', e.message);
    vite.kill();
    process.exit(1);
  });

process.on('SIGINT', () => {
  vite.kill();
  process.exit(0);
});
