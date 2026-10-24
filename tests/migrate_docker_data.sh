#!/bin/bash
# 版权与许可：MIT License, Copyright (c) 2026 chenghongyao
# 本文件属于 Memos 飞牛打包的适配层，与上游 usememos/memos 无关；
# 上游项目：https://github.com/usememos/memos  （MIT, Copyright (c) 2025 Memos）
# 第三方声明见 app/server/NOTICE
# Docker memos（schema 0.22.1）→ 飞牛应用（26.10-rc.1, schema 0.31.8）迁移链
#
# 官方要求的三步升级（memos 启动时会自己提示）：
#   1) v0.25.3   （把 0.22.x 升到 0.25.x）
#   2) v0.31.0   （把 0.25.x 升到 0.31.8）
#   3) 26.10-rc.1（本应用内置的二进制）
#
# 用法: migrate_docker_data.sh <源DB> <目标数据目录>
set -euo pipefail

SRC_DB="$1"
DEST_DIR="$2"
BIN25="/tmp/migtest/memos-0.25.3"
BIN31="/tmp/migtest/memos-0.31.0"
BIN261="/vol1/@appshare/Harness/work/dsh-fnos-gateway/downloads/memos"

[ -f "$SRC_DB" ] || { echo "找不到源 DB: $SRC_DB"; exit 1; }
[ -f "$BIN25" ] && [ -f "$BIN31" ] && [ -f "$BIN261" ] || { echo "缺少迁移用的二进制"; exit 1; }

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp "$SRC_DB" "$DEST_DIR/memos_prod.db"
chmod 600 "$DEST_DIR/memos_prod.db"

run_step() {
    local bin="$1" name="$2"
    shift 2
    echo "===== 步骤: $name ====="
    "$bin" --unix-sock "$DEST_DIR/../mig.sock" --data "$DEST_DIR" "$@" > "$DEST_DIR/../$name.log" 2>&1 &
    local pid=$!
    local i=0
    while [ $i -lt 60 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        if [ -S "$DEST_DIR/../mig.sock" ] && grep -qE 'started successfully' "$DEST_DIR/../$name.log" 2>/dev/null; then
            break
        fi
        sleep 0.5
        i=$((i + 1))
    done
    sleep 2
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    grep -E 'migration|started successfully|ERROR|failed' "$DEST_DIR/../$name.log" | head -30 || true
    echo
}

cd "$(dirname "$DEST_DIR")"
# v0.25.3 默认是 dev 模式（会另建 memos_dev.db），必须显式 prod 才能迁到 memos_prod.db
run_step "$BIN25" "step25" --mode prod
run_step "$BIN31" "step31"
run_step "$BIN261" "step26"

rm -f "$DEST_DIR/memos_prod.db-shm" "$DEST_DIR/memos_prod.db-wal" "$DEST_DIR/memos_dev.db" "$DEST_DIR/memos_dev.db-shm" "$DEST_DIR/memos_dev.db-wal"
echo "迁移完成: $DEST_DIR/memos_prod.db"
ls -la "$DEST_DIR"
