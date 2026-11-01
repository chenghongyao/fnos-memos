#!/usr/bin/env python
# 版权与许可：MIT License, Copyright (c) 2026 chenghongyao
# 本文件属于 Memos 飞牛打包的适配层，与上游 usememos/memos 无关；
# 上游项目：https://github.com/usememos/memos  （MIT, Copyright (c) 2025 Memos）
# 第三方声明见 app/server/NOTICE
#
# 浏览器端验证「统一网关免密登录」
#   - 通过 TCP→unix socket 测试桥访问网关入口（等价于 /app/Memos）
#   - 用 extraHTTPHeaders 模拟网关注入的飞牛身份头
#   - 检查：是否直接进入已登录状态（没有跳到 /auth）、localStorage 里有没有令牌
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:18081/app/Memos")
NAS_USER = os.environ.get("NAS_USER", "ych")
NAS_UID = os.environ.get("NAS_UID", "1000")
OUT = os.environ.get("OUT", "temp/run")
os.makedirs(OUT, exist_ok=True)

errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(
        extra_http_headers={
            "X-Trim-Username": NAS_USER,
            "X-Trim-Userid": NAS_UID,
            "X-Trim-Isadmin": "true",
        }
    )
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_timeout(6000)

    token = pg.evaluate("() => localStorage.getItem('memos_access_token')")
    expires = pg.evaluate("() => localStorage.getItem('memos_token_expires_at')")
    url = pg.url
    body = pg.inner_text("body")[:400]
    pg.screenshot(path=os.path.join(OUT, "sso-browser.png"), full_page=True)

    print("URL      :", url)
    print("token    :", (token or "")[:40], "…len", len(token or ""))
    print("expires  :", expires)
    print("page text:", body.replace("\n", " ")[:300])
    print("errors   :", errors[:5])

    ok = True
    if "/auth" in url:
        print("FAIL: 被跳到登录页")
        ok = False
    if not token:
        print("FAIL: localStorage 里没有访问令牌")
        ok = False
    if errors:
        print("WARN: 页面有 JS 异常")
    b.close()

print("RESULT:", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
