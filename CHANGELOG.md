# Changelog

## 1.7.0 — 2026-11-13

### 新增
- **启动画面**：新增 `electron/splash.html`（460×360 无边框透明圆角），沿用 mousa 手绘标志时间轴：外圈 0.51s → 内圈 0.34+0.48s → 字标 0.69+1.05s → 绿芯 1.5s，底部显示"正在启动…"与版本号。
- 主进程在 `app.whenReady` 阶段先建启动画面，再建主窗口。

### 改动
- 主窗口改为 `show:false`，由 `ready-to-show` + 启动画面交接后显示（消除首屏白屏）。
- 启动画面最短展示 2000ms、最长 6000ms；`did-fail-load` 与超时都会强制显示主窗口。
- `before-quit` 销毁启动画面，避免残留透明窗口。
- 构建：`build:main` 与 `scripts/dev.mjs` 增加 `scripts/copy-assets.mjs`，把 `electron/splash.html` 复制进 `dist-electron/`。

### 验证
- `npm run typecheck`、`npm run build` 通过。
- 实机：`splash-created +197ms`、`window-created +216ms`、`window-revealed +2009ms`；dev 无 vite 时 `load-failed` 仍正确显示。
