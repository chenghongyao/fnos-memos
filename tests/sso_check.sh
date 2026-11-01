#!/bin/bash
# 版权与许可：MIT License, Copyright (c) 2026 chenghongyao
# 本文件属于 Memos 飞牛打包的适配层，与上游 usememos/memos 无关；
# 上游项目：https://github.com/usememos/memos  （MIT, Copyright (c) 2025 Memos）
# 第三方声明见 app/server/NOTICE
#
# 统一网关免密登录（SSO）自检
#   sudo ./tests/sso_check.sh [appname]
#
# 检查项：
#   1. 应用是否在运行、app.sock 是否存在
#   2. 网关桥启动参数里是否带 --data-dir / --sso
#   3. 带飞牛身份头访问 app.sock，HTML 里是否注入了 SSO 脚本与访问令牌
#   4. 不带身份头访问，HTML 里不应出现 SSO 注入（走密码登录）
#   5. 注入的令牌能否被 Memos 认成有效登录
#   6. RefreshToken 是否被网关桥接管
#   7. /_gw/health 里的 sso 映射表
set -u

APP="${1:-Memos}"
APPDEST="/var/apps/${APP}"
# /var/apps/<app>/target 通常是软链（指向 /vol1/@appcenter/<app>），取真实路径
REAL=$(readlink -f "$APPDEST/target" 2>/dev/null)
if [ -n "$REAL" ] && [ -d "$REAL" ]; then APPDEST="$REAL"; fi
SOCK="${APPDEST}/app.sock"
UPSTREAM="${APPDEST}/memos.sock"
LOG="/vol1/@appdata/${APP}/info.log"
NAS_USER="${NAS_USER:-ych}"
NAS_UID="${NAS_UID:-1000}"

ok=0; fail=0
pass() { echo "[ OK ] $1"; ok=$((ok+1)); }
bad()  { echo "[FAIL] $1"; fail=$((fail+1)); }

echo "== 1. 运行状态"
if sudo -n test -S "$SOCK"; then pass "app.sock 存在：$SOCK"; else bad "app.sock 不存在：$SOCK（应用没启动？）"; exit 1; fi
if sudo -n test -S "$UPSTREAM"; then pass "memos.sock 存在：$UPSTREAM"; else bad "memos.sock 不存在：$UPSTREAM"; fi

echo "== 2. 启动参数"
if sudo -n grep -aq -- '--data-dir' "$LOG"; then pass "网关桥带了 --data-dir"; else bad "网关桥启动参数里没有 --data-dir（SSO 读不到数据库）"; fi
if sudo -n grep -aq -- '--sso true' "$LOG"; then pass "SSO 已开启（--sso true）"; else bad "SSO 未开启（--sso false）"; fi

html=$(sudo -n curl -s --unix-socket "$SOCK" -H "X-Trim-Username: ${NAS_USER}" -H "X-Trim-Userid: ${NAS_UID}" -H "X-Trim-Isadmin: true" "http://localhost/app/${APP}/")
token=$(printf '%s' "$html" | grep -o 'memos_access_token","[^"]*"' | sed 's/.*","//;s/"$//')

echo "== 3. 网关身份头 → 注入 SSO 脚本"
if printf '%s' "$html" | grep -q 'data-memos-gateway="sso"'; then pass "HTML 注入了 SSO 脚本"; else bad "HTML 没有 SSO 注入"; fi
if [ -n "$token" ]; then pass "注入了访问令牌（长度 ${#token}）"; else bad "没有拿到访问令牌"; fi

echo "== 4. 无身份头 → 不注入"
plain=$(sudo -n curl -s --unix-socket "$SOCK" "http://localhost/app/${APP}/")
if printf '%s' "$plain" | grep -q 'data-memos-gateway="sso"'; then bad "无身份头也注入了 SSO（不应该）"; else pass "无身份头不注入（走 Memos 密码登录）"; fi

echo "== 5. 令牌有效性"
if [ -n "$token" ]; then
  me=$(sudo -n curl -s --unix-socket "$UPSTREAM" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
        -X POST "http://localhost/memos.api.AuthService/GetCurrentUser" -d '{}')
  if printf '%s' "$me" | grep -q '"user"'; then
    pass "令牌有效：$(printf '%s' "$me" | head -c 160)"
  else
    bad "令牌无效：$(printf '%s' "$me" | head -c 160)"
  fi
fi

echo "== 6. RefreshToken 由网关桥接管"
rt=$(sudo -n curl -s --unix-socket "$SOCK" -H "X-Trim-Username: ${NAS_USER}" -H "X-Trim-Userid: ${NAS_UID}" \
      -X POST "http://localhost/app/${APP}/memos.api.AuthService/RefreshToken" -d '{}')
if printf '%s' "$rt" | grep -q 'accessToken'; then pass "RefreshToken 返回了 accessToken"; else bad "RefreshToken 未被接管：$(printf '%s' "$rt" | head -c 120)"; fi

echo "== 7. /_gw/health 里的 SSO 状态"
sudo -n curl -s --unix-socket "$SOCK" "http://localhost/app/${APP}/_gw/health" | grep -o '"sso".*' | head -c 400; echo

echo
echo "结果：成功 ${ok} 项，失败 ${fail} 项"
[ "$fail" -eq 0 ]
