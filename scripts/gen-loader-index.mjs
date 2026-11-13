// 从本地镜像 maven 聚合目录生成加载器实际资源索引（资源有多少展示多少）
// 输出：<镜像>/maven/{forge,neoforge,fabric,quilt}-index.json = 实际存在的版本号数组
// 用法：node scripts/gen-loader-index.mjs [--mirror <路径>]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MIRROR = (() => {
  const i = process.argv.indexOf('--mirror');
  return i >= 0 ? process.argv[i + 1] : path.join(os.homedir(), '1b1t-mirror');
})();
const MAVEN = path.join(MIRROR, 'maven');

function versionsOf(relPrefix, jarPrefix) {
  const out = [];
  const root = path.join(MAVEN, relPrefix);
  try {
    for (const ver of fs.readdirSync(root)) {
      // 目录内有任何 jar 即视为该版本资源存在（含 -installer 后缀等）
      try {
        const files = fs.readdirSync(path.join(root, ver));
        if (files.some((f) => f.endsWith('.jar'))) out.push(ver);
      } catch {
        // 跳过
      }
    }
  } catch {
    // 目录不存在
  }
  // 版本排序（自然序：先按 MC 世代再按补丁）
  out.sort((a, b) => {
    const pa = a.split(/[-.]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
    const pb = b.split(/[-.]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return a.localeCompare(b);
  });
  return out;
}

function main() {
  const index = {
    forge: versionsOf('net/minecraftforge/forge', 'forge'),
    neoforge: versionsOf('net/neoforged/neoforge', 'neoforge'),
    fabric: versionsOf('net/fabricmc/fabric-loader', 'fabric-loader'),
    quilt: versionsOf('org/quiltmc/quilt-loader', 'quilt-loader'),
  };
  fs.mkdirSync(MAVEN, { recursive: true });
  for (const [kind, vers] of Object.entries(index)) {
    const p = path.join(MAVEN, `${kind}-index.json`);
    fs.writeFileSync(p, JSON.stringify(vers, null, 2));
    console.log(`${kind}: ${vers.length} 个版本 → ${p}`);
  }
  console.log('索引生成完成（上传脚本增量同步到存储桶）');
}

main();
