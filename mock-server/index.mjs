// 自测用模拟 HTTP 服务器：
// - 模拟 1B1T mirror 结构（/serverdown/bmclapi2.bangbang93.com/... + /serverdown/servers/index.json）
// - 模拟备用镜像（/mirror2/...，始终正常）
// - 故障场景开关 /__ctrl/mode?m=offline|hash-bad|slow|interrupt|ok
// 用法：node mock-server/index.mjs [端口，默认 8199]
import * as http from 'node:http';
import * as crypto from 'node:crypto';

const PORT = Number(process.argv[2] ?? 8199);
let mode = 'ok';

// ---- 预生成文件内容（确定性随机 + 记录 SHA1）----
function genContent(seed, size) {
  const buf = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

const FILES = {
  clientJar: genContent(42, 512 * 1024), // 512KB
  lib1: genContent(7, 8 * 1024),
  lib2: genContent(8, 16 * 1024),
  nativeJar: genContent(9, 32 * 1024),
  assetIndex: Buffer.from(JSON.stringify({ objects: { 'a/b': { hash: sha1(genContent(11, 1024)), size: 1024 } } })),
  assetA: genContent(11, 1024),
  manifest: null,
  serverIndex: null,
};
FILES.manifest = Buffer.from(
  JSON.stringify({
    latest: { release: 'mock-1.0', snapshot: 'mock-1.0' },
    versions: [
      { id: 'mock-1.0', type: 'release', url: 'x', time: '2026-01-01T00:00:00+00:00', releaseTime: '2026-01-01T00:00:00+00:00' },
      { id: 'mock-0.9', type: 'snapshot', url: 'x', time: '2025-01-01T00:00:00+00:00', releaseTime: '2025-01-01T00:00:00+00:00' },
    ],
  }),
);
FILES.serverIndex = Buffer.from(
  JSON.stringify({
    servers: [
      { id: 'main', name: 'Mock 主服', address: '127.0.0.1', port: 25565, desc: '自测服务器' },
      { id: 'test', name: 'Mock 测试服', address: '127.0.0.1', port: 25566, desc: '' },
    ],
    coreFiles: [
      { name: 'mock-server.jar', url: `http://127.0.0.1:${PORT}/serverdown/bmclapi2.bangbang93.com/version/mock-1.0/server`, size: FILES.clientJar.length, sha1: sha1(FILES.clientJar) },
    ],
  }),
);

const versionJson = {
  id: 'mock-1.0',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  arguments: {
    game: [
      { value: '--demo' },
      { value: ['--version', '${version_name}'] },
      { value: ['--gameDir', '${game_directory}'] },
      '--assetsDir',
      '${assets_root}',
    ],
    jvm: [
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
      { rules: [{ action: 'allow', os: { arch: 'x86' } }], value: '-Xss1M' },
      '-Djava.library.path=${natives_directory}',
      { value: ['-cp', '${classpath}'] },
      '-Xmx2G',
      '-XX:+UseG1GC',
      'net.minecraft.client.main.Main',
    ],
  },
  downloads: {
    client: { sha1: sha1(FILES.clientJar), size: FILES.clientJar.length },
  },
  assetIndex: {
    id: 'mock',
    url: 'https://piston-meta.mojang.com/v1/packages/mockhash123/mock.json',
    sha1: sha1(FILES.assetIndex),
    size: FILES.assetIndex.length,
  },
  javaVersion: { majorVersion: 21 },
  libraries: [
    {
      name: 'com.example:lib1:1.0',
      downloads: { artifact: { path: 'com/example/lib1/1.0/lib1-1.0.jar', sha1: sha1(FILES.lib1), size: FILES.lib1.length } },
    },
    {
      name: 'com.example:lib2:1.0',
      // 真实数据里的常见写法：默认允许，Windows 上排除（规则“最后一条命中者生效”）
      rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }],
      downloads: { artifact: { path: 'com/example/lib2/1.0/lib2-1.0.jar', sha1: sha1(FILES.lib2), size: FILES.lib2.length } },
    },
    {
      name: 'org.lwjgl:lwjgl:3.3.0',
      rules: [{ action: 'allow', os: { name: 'linux' } }],
      natives: { linux: 'natives-linux' },
      downloads: {
        artifact: { path: 'org/lwjgl/lwjgl/3.3.0/lwjgl-3.3.0.jar', sha1: sha1(FILES.lib2), size: FILES.lib2.length },
        classifiers: { 'natives-linux': { path: 'org/lwjgl/lwjgl/3.3.0/lwjgl-3.3.0-natives-linux.jar', sha1: sha1(FILES.nativeJar), size: FILES.nativeJar.length } },
      },
    },
  ],
};

// ---- 路径路由 ----
const VERSION_JSON_BUF = Buffer.from(JSON.stringify(versionJson));

function route(req, res, base) {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  const rel = p.replace(/^\//, '').replace(base.replace(/^\//, ''), '');

  // 服务器索引
  if (p.endsWith('/servers/index.json')) {
    return send(req, res, 200, FILES.serverIndex, 'application/json');
  }
  if (/\/version_manifest_v2\.json$/.test(p)) {
    return send(req, res, 200, FILES.manifest, 'application/json');
  }
  if (/\/version\/mock-[\d.]+\/json$/.test(p)) {
    return send(req, res, 200, VERSION_JSON_BUF, 'application/json');
  }
  if (/\/version\/mock-[\d.]+\/client$/.test(p)) {
    return clientFile(req, res, p, FILES.clientJar, sha1(FILES.clientJar));
  }
  if (/\/version\/mock-[\d.]+\/server$/.test(p)) {
    return send(req, res, 200, FILES.clientJar, 'application/octet-stream');
  }
  if (/\/libraries\/com\/example\/lib1\//.test(p)) {
    return send(req, res, 200, FILES.lib1, 'application/octet-stream');
  }
  if (/\/libraries\/com\/example\/lib2\//.test(p)) {
    return send(req, res, 200, FILES.lib2, 'application/octet-stream');
  }
  if (p.includes('natives-linux.jar')) {
    return send(req, res, 200, FILES.nativeJar, 'application/octet-stream');
  }
  if (p.includes('lwjgl-3.3.0.jar')) {
    return send(req, res, 200, FILES.lib2, 'application/octet-stream');
  }
  if (/\/indexes\/mock\.json$/.test(p) || /\/v1\/packages\/mockhash123\/mock\.json$/.test(p)) {
    return send(req, res, 200, FILES.assetIndex, 'application/json');
  }
  if (/\/assets\//.test(p)) {
    return send(req, res, 200, FILES.assetA, 'application/octet-stream');
  }
  // 未部署的客户端资源（模拟镜像缺失）→ 404
  return send(req, res, 404, Buffer.from('not found'), 'text/plain');
}

function clientFile(req, res, p, content, expectedSha1) {
  // mock-0.9 作为「备用源」模拟：恒正常，不受故障模式影响
  if (p.includes('mock-0.9')) {
    return send(req, res, 200, content, 'application/octet-stream');
  }
  if (mode === 'offline') return send(req, res, 503, Buffer.from('offline'), 'text/plain');
  if (mode === 'hash-bad') {
    // 内容错误 → SHA1 对不上
    return send(req, res, 200, Buffer.from('corrupted-content'), 'application/octet-stream');
  }
  if (mode === 'interrupt') {
    // 只发一半就断（Content-Length 标全量，实际截断）
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.length),
      'Accept-Ranges': 'bytes',
    });
    res.write(content.subarray(0, Math.floor(content.length / 2)));
    setTimeout(() => res.destroy(), 300);
    return;
  }
  if (mode === 'slow') {
    // 限速：每 100ms 发 2KB（约 20KB/s）
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.length),
      'Accept-Ranges': 'bytes',
    });
    let off = 0;
    const timer = setInterval(() => {
      if (off >= content.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(content.subarray(off, Math.min(off + 2048, content.length)));
      off += 2048;
    }, 100);
    res.on('close', () => clearInterval(timer));
    return;
  }
  return send(req, res, 200, content, 'application/octet-stream');
}

function send(req, res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

let rangeRequests = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // 控制端点
  if (u.pathname === '/__ctrl/mode') {
    mode = u.searchParams.get('m') ?? 'ok';
    return send(req, res, 200, Buffer.from(`mode=${mode}`), 'text/plain');
  }
  if (u.pathname === '/__ctrl/status') {
    return send(req, res, 200, Buffer.from(JSON.stringify({ mode })), 'application/json');
  }
  if (u.pathname === '/__ctrl/stats') {
    return send(req, res, 200, Buffer.from(JSON.stringify({ rangeRequests })), 'application/json');
  }
  // Range 支持（client 文件；故障模式交给 clientFile 处理，此处仅处理正常模式）
  const range = req.headers.range;
  if (range && /^bytes=(\d+)-(\d*)$/.test(range)) {
    if (/\/client$/.test(u.pathname) && mode === 'ok') {
      rangeRequests += 1;
      const m = range.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(m[1]);
      const content = FILES.clientJar;
      const end = m[2] ? Number(m[2]) : content.length - 1;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${content.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(content.subarray(start, end + 1));
    }
  }
  route(req, res, '/serverdown/bmclapi2.bangbang93.com');
});

server.listen(PORT, () => {
  console.log(`[mock-server] http://127.0.0.1:${PORT}  (mode=${mode})`);
  console.log(`[mock-server] 控制端点: /__ctrl/mode?m=ok|offline|hash-bad|slow|interrupt`);
});
