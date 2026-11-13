# MCore Launcher

轻量、私有镜像优先的 Minecraft 启动器 —— Electron + React + TypeScript，Windows / macOS / Linux 三端通用。

> 镜像默认走 1B1T 私有镜像，逐级降级 BMCLAPI → Mojang 官方源，受限网络下也能装得上。

## 下载

| 平台 | 安装包 |
|---|---|
| macOS（Apple 芯片） | https://www.1b1t.cn/mcore/MCore%20Launcher-1.7.0-arm64.dmg |
| macOS（自动更新包） | https://www.1b1t.cn/mcore/MCore%20Launcher-1.7.0-mac-arm64.zip |
| Windows / Linux | 见 https://www.1b1t.cn/downloads.html |

全部版本与校验值：<https://www.1b1t.cn/downloads.html> · 历史版本：<https://www.1b1t.cn/mcore/>

## 功能

- 离线登录（多账户，3–16 位用户名）+ 正版登录
- 917 个版本列表，按类型过滤、搜索
- Forge / NeoForge / Fabric / Quilt 加载器一站式安装（已装版本也可加装）
- 模组页：Modrinth 搜索、一键安装、自动补装依赖、启停与删除、按哈希查更新
- Java 全渠道探测（PATH / JAVA_HOME / 常见安装目录 / 注册表），按版本自动匹配，缺失自动下载
- 下载进度页（每文件进度、独立任务）、差分更新、自定义壁纸、崩溃分析
- 1.7.0 起：mousa 启动画面（无边框透明圆角，最短 2s、最长 6s，失败兜底显示主窗口）

## 开发

```bash
npm install
npm run dev     # 编译主进程 + vite + electron
npm run build   # 渲染进程 + 主进程（含 splash.html 资源复制）
npm run typecheck
npm run dist    # electron-builder 打包
```

主进程在 `electron/`（12 个模块），渲染进程在 `src/`（5 个页面）；`electron/splash.html` 是启动画面。

## 说明

- macOS 包为 ad-hoc 签名：首次打开若提示「已损坏」，右键 → 打开，或
  `xattr -dr com.apple.quarantine "/Applications/MCore Launcher.app"`
- Windows 安装包未签名：SmartScreen 里点「更多信息 → 仍要运行」
