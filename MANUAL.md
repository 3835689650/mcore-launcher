# MCore Launcher 技术手册

> 本文档为 MCore Launcher 私有项目内部技术文档，仅随成品交付，不对外公开发布。

## 1. 项目概述

MCore Launcher 是面向 1B1T 私有镜像的轻量化 Minecraft 三端启动器（Windows / macOS / Linux）。

- 技术栈：Electron + Vite + React + TypeScript + Tailwind CSS + shadcn/ui 风格组件（Radix UI）+ Lucide 图标
- 定位：轻量、精简，只做「离线登录 → 拉取资源 → 启动游戏」主干链路
- 资源源：1B1T mirror（第一优先）→ BMCLAPI 国内镜像（第二优先）→ Mojang 官方源（第三优先），自动测速降级 / 手动锁定
- 服务器配置与核心文件仅从 1B1T mirror 读取，不做降级
- 客户端资源同步属于独立工具任务，启动器只负责按源策略下载

## 2. 部署说明

### 2.1 运行环境

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10+ / macOS 11+ / Linux（主流发行版） |
| Java | 按目标 MC 版本：1.21.x 需 Java 21；1.18-1.20.4 需 Java 17；1.17 需 Java 16；1.16.5 及以下需 Java 8 |
| 磁盘 | 每个版本约 600-800MB（jar + 依赖库 + 资产），多版本共享 assets 目录 |
| 网络 | 能访问 1B1T mirror（www.1b1t.cn）或备用镜像 |

### 2.2 目录布局（运行期）

```
~/.minecraft/                    ← 游戏目录（默认，可在设置中修改）
├── assets/
│   ├── indexes/<id>.json        ← 资产索引
│   └── objects/<h2>/<hash>      ← 资产文件（SHA1 寻址）
├── libraries/<group>/...        ← 依赖库（含 natives）
└── versions/<id>/
    ├── <id>.json                ← 版本描述
    ├── <id>.jar                 ← 客户端核心
    └── natives/                 ← 解压后的平台原生库

<用户数据目录>/mcore-launcher/    ← 启动器配置
├── settings.json                ← 用户设置
└── mirrors.json                 ← 资源源列表（可手工新增源）
```

用户数据目录：Windows `%APPDATA%/mcore-launcher`，macOS `~/Library/Application Support/mcore-launcher`，Linux `~/.config/mcore-launcher`。

## 3. 配置文件详解

### 3.1 settings.json（用户设置，启动器自动读写）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| username | string | "" | 兼容字段（旧版单用户名，自动迁移） |
| accounts | array | [] | 离线账户列表 `[{ "name": "..." }]`（多账户） |
| currentAccount | string | "" | 当前选中账户名 |
| wallpaper | string | "" | 自定义壁纸文件路径，空=内置默认壁纸 |
| theme | string | "system" | 主题：system / light / dark |
| glassEnabled | boolean | true | 液态玻璃开关 |
| glassOpacity | number | 70 | 玻璃透明度 0-100 |
| language | string | "system" | 语言 id（system=跟随系统；zh-CN / zh-TW / en-US） |
| sourceMode | string | "auto" | 资源源模式：auto=自动切换 / manual=手动锁定 |
| manualSourceId | string | "1b1t" | 手动模式选中的源 id |
| memoryGB | number | 2 | 游戏内存上限（GB） |
| javaPath | string | "" | 手动指定 Java 路径，空=自动探测 |
| gameDir | string | "" | 游戏目录，空=标准 .minecraft |
| versionFilter | string | "all" | 版本列表过滤：all / release / snapshot / old |
| closeAction | string | "ask" | 关闭窗口行为：ask / exit / tray |

### 3.2 mirrors.json（资源源列表）

首次启动自动生成默认值。**新增资源源只需编辑此文件，无需重新编译**。结构：

```json
{
  "clientSources": [
    {
      "id": "1b1t",
      "name": "1B1T mirror",
      "type": "client",
      "protocol": "bmclapi",
      "baseUrl": "https://www.1b1t.cn/serverdown/bmclapi2.bangbang93.com",
      "priority": 1,
      "enabled": true
    }
  ],
  "serverSource": {
    "id": "1b1t-server",
    "name": "1B1T mirror 服务器源",
    "type": "server",
    "protocol": "bmclapi",
    "baseUrl": "https://www.1b1t.cn/serverdown",
    "priority": 1,
    "enabled": true
  }
}
```

字段说明：

- `id`：唯一标识，手动模式选择源时使用
- `type`：`client`=客户端资源源（参与优先级排序）；`server`=服务器文件源（仅 1B1T，不参与降级）
- `protocol`：
  - `bmclapi`：单一基地址镜像（1B1T mirror、BMCLAPI 及同类镜像站用）
  - `official`：Mojang 官方多域名源（manifest 走 baseUrl，其余文件用 version.json 内原始 URL）
- `baseUrl`：镜像根地址（末尾不带斜杠）
- `priority`：数值越小越优先（自动模式）
- `enabled`：false 时该源不参与任何下载

### 3.3 语言包（外置）

打包后位于安装目录 `resources/locales/`，每个语言一个 JSON 文件（如 `zh-CN.json`）。新增语言 = 新增一个 JSON 文件并加一行 `"_label": "语言名"`，重启启动器即出现在设置页语言列表，**无需重新编译**。

## 4. 资源源配置方法

### 4.1 镜像目录约定（与同步工具对接）

1B1T mirror 以 `https://www.1b1t.cn/serverdown/` 为根，目录结构如下（与 BMCLAPI 新版及 Mojang 官方路径同构）：

| 资源 | 镜像路径 |
|---|---|
| 版本清单 | `/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json` |
| 版本描述 | `/bmclapi2.bangbang93.com/version/<版本>/json` |
| 客户端核心 | `/bmclapi2.bangbang93.com/version/<版本>/client` |
| 服务端核心 | `/bmclapi2.bangbang93.com/version/<版本>/server`（已就位） |
| 依赖库 | `/bmclapi2.bangbang93.com/libraries/<库相对路径>` |
| 资产索引 | `/bmclapi2.bangbang93.com/v1/packages/<hash>/<名称>.json` |
| 资产文件 | `/bmclapi2.bangbang93.com/assets/<hash前2位>/<hash>` |
| 服务器配置 | `/servers/index.json` |

### 4.2 servers/index.json 格式（1B1T mirror 部署）

```json
{
  "servers": [
    { "id": "main", "name": "1B1T 主服", "address": "www.1b1t.cn", "port": 25565, "desc": "描述（可空）" }
  ],
  "coreFiles": [
    {
      "name": "1.21.1 服务端核心",
      "url": "https://www.1b1t.cn/serverdown/bmclapi2.bangbang93.com/version/1.21.1/server",
      "size": 51627615,
      "sha1": "（可选，提供则下载后校验）"
    }
  ]
}
```

### 4.3 测速与降级规则

- 自动模式：每次开始下载前，对当前最高优先级源执行 HEAD 探活（5 秒超时）+ 下载版本清单实测速度（均速 ≥256KB/s 判可用）；不可用则依优先级降级。下载中途断开/过慢（5 秒窗口均速 <256KB/s）同样切换到下一源，断点续传衔接（`.part` 文件保留）。
- 手动模式：只使用用户选中的源，失败直接提示，不切换。
- 服务器相关文件：只走 `serverSource`，失败提示「服务器配置源无法访问」，不去备用/官方源。

### 4.4 新增一个资源源（示例）

编辑 `mirrors.json`，在 `clientSources` 数组追加（假设新镜像站与 BMCLAPI 同构）：

```json
{
  "id": "my-mirror",
  "name": "我的镜像站",
  "type": "client",
  "protocol": "bmclapi",
  "baseUrl": "https://mirror.example.com/mc",
  "priority": 2,
  "enabled": true
}
```

保存后重启启动器即生效（设置页可测速、手动模式可选它）。

### 4.5 下载源接口规范（mcdown 存储桶 / 1B1T mirror）

私有镜像源（Rains3 存储桶 `mcdown`，域名 `https://mcdown.cn-nb1.rains3.com`）按以下 URL 结构提供全部资源。启动器对 1b1t 源（协议 `bmclapi`）的请求路径与下表一一对应；文件缺失时自动降级 BMCLAPI → Mojang 官方。

| 资源 | 镜像 URL 结构 | 示例 |
|---|---|---|
| 版本清单 | `/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json` | 全量 917 版本列表 |
| 版本描述 json | `/bmclapi2.bangbang93.com/version/<版本>/json` | `version/1.21.1/json` |
| 客户端核心 jar | `/bmclapi2.bangbang93.com/version/<版本>/client` | `version/1.21.1/client` |
| 服务端核心 jar | `/bmclapi2.bangbang93.com/version/<版本>/server` | `version/1.21.1/server` |
| Mojang 依赖库 | `/bmclapi2.bangbang93.com/libraries/<库相对路径>` | `libraries/com/mojang/logging/1.1.1/logging-1.1.1.jar` |
| 资产索引 | `/bmclapi2.bangbang93.com/v1/packages/<hash>/<名称>.json` | `v1/packages/9b16…/17.json` |
| 资产文件 | `/bmclapi2.bangbang93.com/assets/<hash前2位>/<hash>` | `assets/b6/b62c…` |
| 加载器 maven 库 | `/maven/<maven 坐标路径>` | `maven/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar`、`maven/net/minecraftforge/forge/1.21.1-52.1.16/forge-1.21.1-52.1.16-installer.jar`、`maven/net/neoforged/neoforge/21.1.255/neoforge-21.1.255-installer.jar`（NeoForge 聚合路径**不含** releases 段） |
| fabric-meta | `/fabric-meta/v2/versions/loader/<MC版本>/index.json`（列表）与 `/<MC版本>/<loader版本>`（版本 meta） | `fabric-meta/v2/versions/loader/1.21.1/index.json` |
| quilt-meta | `/quilt-meta/v3/versions/loader/<MC版本>/index.json` 与 `/<MC版本>/<loader版本>` | 同 fabric 规则 |
| API mod | `/modrinth/<官方 cdn 路径>` | `modrinth/data/<项目>/versions/<id>/fabric-api-<版本>.jar` |
| 服务器配置 | `https://www.1b1t.cn/serverdown/servers/index.json`（本站，不走存储桶） | 见 4.2 |

**说明**：fabric-meta 列表文件在镜像落盘为 `<MC版本>/index.json`（meta API 的 `loader/<mc>` 既是列表又是目录，文件系统需区分）；BMCLAPI 与官方源保持原生路径（无 index.json 后缀），启动器按源自动适配。

### 4.6 镜像同步与上传技术说明

**架构**：本地镜像目录 `~/1b1t-mirror`（权威数据源）→ 增量上传 → Rains3 存储桶 `mcdown`（公网分发，80GB 配额）。

**同步工具链**（`scripts/`）：

| 脚本 | 作用 |
|---|---|
| `sync-mirror.mjs <版本>` | 单版本原版客户端资源同步（jar/json/libraries/assets） |
| `sync-all.mjs` | 全量 917 版本同步（子 agent 执行，断点续跑） |
| `sync-loaders.mjs <MC版本>` | 单版本加载器资源（fabric-meta/quilt-meta/maven 聚合/API mod） |
| `sync-loaders-all.mjs` | 全量 Fabric/Quilt（全部 MC 版本列表+meta、全部 loader 版本 jar、全部映射、API mod 全版本），8+16 并发 |
| `upload-s3.py` | 本地镜像 → mcdown 桶增量上传（16 并发，同大小跳过；maven 域名目录自动映射为 `/maven` 聚合 key） |

**上传进度监控**：`/home/yu/progress.py`（http://127.0.0.1:8099），按上传日志行（`OK/FAIL/SKIP <key>`）计数，浏览器实时查看。

**网页展示**：https://www.1b1t.cn/mirror/mc.php（源码 `/home/yu/openmc-pan-build/mirror/mc.php`，5 分钟缓存扫描镜像目录，展示版本/加载器资源与下载直链）。

**加载器双端通用性**：Forge/NeoForge 的 installer jar 为官方双端通用安装器（同一文件安装客户端与服务端），客户端启动器解析 installer 内 `install_profile.json`（新版经 `json` 字段指向 `version.json`）生成客户端版本环境；镜像中 24GB Forge 库 + 4GB NeoForge 库为两端共用。

## 5. 功能说明

| 功能 | 说明 |
|---|---|
| 离线登录 | 多账户管理（侧栏 Logo 下「+」添加，主页下拉切换）；用户名 3-16 位字母/数字/下划线；UUID 按 MC 规范从用户名派生（换启动器不丢存档）；不校验皮肤 |
| 版本列表 | 读取当前源链的版本清单，设置页可过滤全部/正式/快照/远古，虚拟滚动支持上千版本 |
| 下载页 | 独立下载任务页：总进度、文件级状态（等待/下载/校验/失败）、失败文件数、取消 |
| 资源下载 | 8 文件并发、SHA1 校验失败自动重下、Range 断点续传（`.part`）、同源重试 3 次后换源；assetIndex 先于资产下载并解析 |
| Java 探测 | JAVA_HOME + PATH + 常见安装路径 + Windows 注册表全渠道扫描，`java -version` 实测；version.json 有 `javaVersion.majorVersion` 优先，缺失按版本区间推断；支持手动指定路径 |
| 内存 | 1-16G 滑块，默认 2G，替换/追加 `-Xmx` |
| 启动 | 按 version.json 的 arguments 原样拼装（变量替换、rules 过滤含 os.name/os.arch、纯字符串条目与对象条目混合格式均支持、natives 解压），游戏进程独立，日志实时回显 |
| 服务器 | 读镜像 servers/index.json；「加入并启动」注入 `--server --port`；核心文件下载（SHA1 校验、断点续传、保存位置自选） |
| 模组下载 | 「模组」页：按 MC 版本 + 加载器搜索 Modrinth，一键安装到 `mods/`（文件优先 1B1T 镜像、官方 CDN 兜底，SHA1 校验、自动装必需依赖）；已装模组可启用/禁用（改名 `.disabled`）/删除 |
| 启动提速 | 已装版本启动优先读本地 version.json（离线可启动）；Java 扫描结果缓存 60s；jar 大小匹配时跳过 SHA1；存档备份 1 小时内只做一次；natives 解压带签名标记，未变化跳过；前置耗时写入游戏日志 |
| 启动器启动 | 非首屏页面按需加载（Vite 代码分割），`asar` 打包（单文件、减少冷启动文件扫描） |
| 主题 | 亮/暗/跟随系统，记住上次选择 |
| 壁纸 | 内置 MC 像素风默认壁纸；设置页可自定义本地图片（png/jpg/webp，自动复制到用户数据目录），壁纸铺满整个界面底层，遮罩随主题自动适配明暗 |
| 液态玻璃 | 壁纸/纯色底色之上叠加毛玻璃图层，透明度滑块 0-100%，关闭时控件自动适配底色对比度 |
| 多语言 | 简体中文 / 繁体中文 / 英文，语言包外置可扩展 |
| 关闭行为 | 弹窗询问退出/托盘（可记住选择） |

## 6. 已知限制

1. 仅离线登录，正版（Mojang 账号）登录为后续版本功能。
2. 模组仅对接 Modrinth（搜索/版本/文件）；CurseForge 未接入。模组只安装到游戏目录 `mods/`，不做按版本隔离。
3. 无内置预设版本；版本列表全部实时从网络拉取，镜像未部署客户端资源且外网不可达时列表为空。
4. 不兼容远古快照的极端字段（如老式 assets 索引结构）；version.json 缺失字段一律跳过，不做脑补。
5. Linux 桌面无系统级窗口模糊 API，玻璃效果为应用内毛玻璃图层（跨平台表现一致）。
6. macOS 打包需在 macOS 机器（或 CI）上执行；Windows 打包在 Linux 上需要 wine（或使用 CI）。
7. 服务器核心文件下载仅允许 1B1T mirror 域名直链（安全限制）。
8. 下载限速判定对极小文件（<8KB）不生效（按可达判定）。
9. BMCLAPI 新版 CDN 对同一文件的高频重复请求会间歇性 404（频控），设置页测速带 60 秒结果缓存；下载器本身不受影响（重试+换源兜底）。
10. 测速判定阈值为 128KB/s（连通性优先）；下载中途的慢速切换阈值仍为 256KB/s。

## 7. 编译步骤

```bash
# 环境要求：Node.js 20+，npm
npm install                     # 安装依赖（Electron 走 npmmirror 镜像：
                                #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install）

npm run build                   # 构建渲染进程（vite）+ 主进程（tsc）
npm run typecheck               # 类型检查
npm run test:unit               # 主干逻辑自测（自动起 mock 服务器，14 项）
npx electron scripts/e2e-test.mjs   # 真机 e2e（需图形环境与 Java，会真实下载并启动 MC）
npm run dev                     # 开发模式（vite 热更新 + electron）
```

构建产物：`dist/`（渲染进程）、`dist-electron/`（主进程）。

## 8. 三端打包指南

### 8.1 Linux（本机已验证）

```bash
# 方式 A：electron-builder（需可访问 GitHub 或配镜像下载工具链）
export PATH="$HOME/.local/share/gem/ruby/3.3.0/bin:$PATH"
USE_SYSTEM_FPM=true \
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --linux          # AppImage + deb

# 方式 B：本地工具直打 deb（无任何网络依赖，推荐）
npx electron-builder --linux dir      # 仅产出 linux-unpacked（或用已有产物）
# 然后执行 scripts/build-deb.sh（自动组装 DEBIAN 元数据并调 dpkg-deb）
```

打包前置元数据要求（package.json 已就位，勿删）：`author.email`（deb maintainer）、`homepage`（deb 首页）。
系统 fpm 安装：`gem install fpm --user-install --no-document`（Debian 无 fpm 包时）。

### 8.2 Windows / macOS

```bash
npx electron-builder --win      # Windows：NSIS 安装包（Linux 上需 wine）
npx electron-builder --mac      # macOS：dmg（仅 macOS 机器）
```

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows | `MCore Launcher Setup x.x.x.exe` | NSIS，可选安装目录；无签名（如需签名配置证书） |
| macOS | `MCore Launcher-x.x.x.dmg` | 未公证/未签名，首次打开需右键打开 |
| Linux | `.AppImage` + `.deb` | deb 未签名，安装需 `--allow-unauthenticated` 或配置 GPG |

图标由 `node scripts/gen-icons.mjs` 生成（纯代码，无外部素材）。语言包随包分发（extraResources）。

**推荐发布方式**：三端均走 GitHub Actions（Windows/macOS runner 各自打包，Linux 本机打包），与 1b1t-open-server 现有发布流程一致。

## 9. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 版本列表为空 | 全部资源源不可达 | 设置页点「测速」查看各源状态；检查网络；镜像未部署时可临时把 BMCLAPI 优先级调为 1 |
| 提示「服务器配置源无法访问」 | 镜像 `/servers/index.json` 不存在或 1B1T 不可达 | 检查镜像是否部署了 servers/index.json（见 4.2） |
| 下载中途一直换源 | 所有源速度 <256KB/s | 检查网络带宽；临时调低预期可等待；限速源会被自动跳过 |
| 启动提示缺 Java | 本机无匹配版本 | 设置页「重新扫描」；或手动指定 Java 路径；安装所需 Java 版本（见 2.1 对照表） |
| 游戏闪退 | 内存不足 / Java 版本不匹配 | 提高内存滑块；确认 Java major 匹配（1.21.1 需 21）；查看游戏日志面板报错 |
| 玻璃效果看不出 | 透明度太低 | 设置页调高玻璃透明度滑块 |
| 下载残留 `.part` 文件 | 上次下载中断 | 正常现象，下次下载自动续传；损坏可手动删除 |
| 语言未生效 | 语言包文件缺失 | 确认安装目录 `resources/locales/` 内有对应 JSON 文件 |
| 手动模式仍切源 | mirrors.json 中该源 enabled=false 或 priority 异常 | 检查 mirrors.json；手动模式只锁定一个源，失败直接报错 |
| 设置丢失 | 用户数据目录被清理 | 设置存于用户数据目录（见 2.2），勿删除 |

### 日志位置

游戏运行日志显示在启动器「游戏日志」面板；启动器自身无文件日志（精简设计），排查问题以界面提示与游戏日志为准。

## 10. 附：自测记录

- 单元自测（`npm run test:unit`）：15 项——离线 UUID/用户名校验/SHA1/正常下载/断点续传/哈希失败换源/慢速换源/中断换源/全源失败上报/服务器索引/测速/源链模式/zip 解压/启动参数生成/规则求值（最后命中生效），全部通过。
- 模组链路实测（2026-10）：搜索 `sodium`（1.21.1/fabric）20 条、版本 22 个；安装 `iris` 自动补装依赖 `sodium`；启用/禁用/删除均验证；UI 点击安装后 `mods/` 出现对应 jar。
- 启动耗时实测（Linux x86_64）：打包版窗口创建约 0.16-0.23s、首屏加载完成约 0.3-0.8s；游戏启动前置（Java 匹配/资源校验/备份/natives）由秒级降到约 0.2-0.6s（首次 Java 扫描约 0.4s，之后命中缓存 0ms）。
- 真机 e2e（`npx electron scripts/e2e-test.cjs`，需图形环境+Java）：10 项——UI 渲染/设置默认值/主题切换/液态玻璃/多语言/Java 探测（本机发现 Java 21+25）/真实版本列表（917 条）/真实源测速/真实下载 1.21.1 全部资源 + Java 21 真启动游戏（1B1T 无客户端资源自动降级 BMCLAPI，SHA1 校验+断点续传全链路）/服务器源错误分支，全部通过。
- 资源端点均经 2026-10 实测：1B1T mirror 直链（Range 206）、BMCLAPI 新版路径（manifest 为 `/mc/game/version_manifest_v2.json`，assetIndex 为 `/v1/packages/<hash>/<name>.json`，libraries 302 签名跳转由启动器自动跟随）。
- 自测中发现并修复的真实缺陷：Electron ESM 入口下 whenReady 挂起（改 CJS 入口）、语言包 dev 路径偏移、Java 探测 PATH 非目录条目 ENOTDIR、React hook 数量不一致崩溃（#310）、BMCLAPI CDN 对 HEAD/密集请求的间歇 404（测速改为以 GET 实测为准+60 秒缓存）。
