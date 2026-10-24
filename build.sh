#!/bin/bash
# 版权与许可：MIT License, Copyright (c) 2026 chenghongyao
# 本文件属于 Memos 飞牛打包的适配层，与上游 usememos/memos 无关；
# 上游项目：https://github.com/usememos/memos  （MIT, Copyright (c) 2025 Memos）
# 第三方声明见 app/server/NOTICE
#
# 打包成 .fpk
#   ./build.sh            # 缺二进制时自动下载并校验 sha256
#   SKIP_DOWNLOAD=1 ./build.sh   # 只用本地已有的 app/server/memos
set -euo pipefail
cd "$(dirname "$0")"

command -v fnpack >/dev/null || { echo "缺少 fnpack，请先安装飞牛开发工具"; exit 1; }

# ------------------------------------------------------------------ 上游二进制
UPSTREAM_VER="26.10-rc.1"
UPSTREAM_URL="https://github.com/usememos/memos/releases/download/${UPSTREAM_VER}/memos_${UPSTREAM_VER}_linux_arm64.tar.gz"
UPSTREAM_SHA256="796d85b70e8de58a6bb7fe69b9a10a5942e4936e913249a30fd01c7b6afc15e6"
BIN="app/server/memos"

ensure_binary() {
    if [ -x "${BIN}" ] && [ "${SKIP_DOWNLOAD:-0}" != "1" ]; then
        echo "上游二进制已存在：${BIN}（$(du -h "${BIN}" | cut -f1)）"
        return 0
    fi
    if [ "${SKIP_DOWNLOAD:-0}" = "1" ]; then
        [ -x "${BIN}" ] || { echo "SKIP_DOWNLOAD=1 但 ${BIN} 不存在"; exit 1; }
        return 0
    fi

    mkdir -p downloads
    local tgz="downloads/memos_${UPSTREAM_VER}_linux_arm64.tar.gz"
    if [ ! -f "${tgz}" ]; then
        echo "下载上游 memos ${UPSTREAM_VER}（linux_arm64）..."
        curl -fL --retry 3 -o "${tgz}" "${UPSTREAM_URL}"
    fi

    echo "校验 sha256..."
    local got
    got=$(sha256sum "${tgz}" | awk '{print $1}')
    if [ "${got}" != "${UPSTREAM_SHA256}" ]; then
        echo "sha256 不匹配！"
        echo "  期望: ${UPSTREAM_SHA256}"
        echo "  实际: ${got}"
        exit 1
    fi
    echo "sha256 校验通过"

    # 官方 tar.gz 里只有一个 `memos` 文件，直接解到 app/server/
    tar -xzf "${tgz}" -C app/server
    chmod 755 "${BIN}"
    echo "已解出：${BIN}（sha256 $(sha256sum "${BIN}" | awk '{print $1}')）"
}

ensure_binary

# ------------------------------------------------------------------ 组装
STAGE=$(mktemp -d /tmp/memos-fpk.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

cp manifest ICON.PNG ICON_256.PNG "$STAGE"/
# 版权与许可：NOTICE + 上游 MIT 许可证全文随 app/server 一起分发
# （MIT 要求许可文本随二进制一同提供；fnpack 只保留 manifest/ICON/app 等已知目录）
cp -r cmd config app wizard "$STAGE"/
find "$STAGE" -name '.DS_Store' -delete

# 版本号写进应用目录，网关桥的「关于」显示
VER=$(awk -F'=' '/^version[ \t]*=/{gsub(/[ \t]/,"",$2); print $2; exit}' manifest)
[ -n "${VER}" ] && printf '{"version":"%s"}\n' "${VER}" > "$STAGE/app/server/version.json" \
    && echo "版本号已写入：${VER}"

# 确保二进制可执行
chmod 755 "$STAGE/app/server/memos" "$STAGE/app/server/bridge.js" 2>/dev/null || true

echo "打包目录：$STAGE"
fnpack build --directory "$STAGE"
OUT=$(ls -t "$STAGE"/*.fpk 2>/dev/null | head -1)
if [ -n "${OUT}" ]; then
    cp "$OUT" .
    echo "产物：$(pwd)/$(basename "$OUT")"
    ls -lh "$(pwd)/$(basename "$OUT")"
else
    echo "没找到 .fpk 产物"
    exit 1
fi
