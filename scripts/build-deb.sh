#!/bin/bash
# 本地工具直打 deb：无网络依赖，用 dpkg-deb 组装
# 前置：release/linux-unpacked 已存在（npx electron-builder --linux dir 产出）
# 用法：bash scripts/build-deb.sh [版本，默认 1.0.0]
set -e
VER="${1:-1.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNPACKED="$ROOT/release/linux-unpacked"
OUT="$ROOT/release/mcore-launcher_${VER}_amd64.deb"

[ -d "$UNPACKED" ] || { echo "缺少 $UNPACKED，先跑: npx electron-builder --linux dir"; exit 1; }
[ -f "$ROOT/resources/icon.png" ] || { echo "缺少图标，先跑: node scripts/gen-icons.mjs"; exit 1; }

BUILD="$ROOT/release/deb-root"
rm -rf "$BUILD"
mkdir -p "$BUILD/DEBIAN" "$BUILD/opt/mcore-launcher" \
         "$BUILD/usr/share/applications" "$BUILD/usr/share/icons/hicolor/512x512/apps"

cp -a "$UNPACKED/." "$BUILD/opt/mcore-launcher/"
# chrome-sandbox 需要 setuid root
chmod 4755 "$BUILD/opt/mcore-launcher/chrome-sandbox"

cat > "$BUILD/DEBIAN/control" <<EOF
Package: mcore-launcher
Version: ${VER}
Section: games
Priority: optional
Architecture: amd64
Maintainer: 1B1T <admin@1b1t.cn>
Homepage: https://www.1b1t.cn
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0
Description: MCore Launcher - 轻量私有镜像 Minecraft 启动器
 1B1T 私有镜像专用 Minecraft 三端启动器，支持离线登录、
 多源自动切换下载、SHA1 校验、断点续传与 Java 自动探测。
EOF

cat > "$BUILD/usr/share/applications/mcore-launcher.desktop" <<'EOF'
[Desktop Entry]
Name=MCore Launcher
Comment=1B1T 私有镜像 Minecraft 启动器
Exec=/opt/mcore-launcher/mcore-launcher %U
Icon=mcore-launcher
Terminal=false
Type=Application
Categories=Game;
StartupWMClass=mcore-launcher
EOF

cp "$ROOT/resources/icon.png" "$BUILD/usr/share/icons/hicolor/512x512/apps/mcore-launcher.png"
dpkg-deb --build "$BUILD" "$OUT"
echo "deb 已生成: $OUT"
