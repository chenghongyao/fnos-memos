#!/usr/bin/env python
# 附件（图片）加载排查：记录所有 attachment 相关请求的状态码
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:18081/app/Memos")
NAS_USER = os.environ.get("NAS_USER", "ych")
NAS_UID = os.environ.get("NAS_UID", "1000")
OUT = os.environ.get("OUT", "temp/run")
os.makedirs(OUT, exist_ok=True)

rows = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(extra_http_headers={
        "X-Trim-Username": NAS_USER, "X-Trim-Userid": NAS_UID, "X-Trim-Isadmin": "true"})
    pg = ctx.new_page()
    pg.on("response", lambda r: rows.append((r.status, r.url)))
    pg.on("requestfailed", lambda r: rows.append(("FAILED:" + str(r.failure), r.url)))
    pg.goto(BASE + "/", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_timeout(7000)
    pg.screenshot(path=os.path.join(OUT, "attach-debug.png"), full_page=False)
    b.close()

for st, u in rows:
    if "attach" in u.lower() or "file" in u.lower() or (isinstance(st, int) and st >= 400):
        print(st, u[:160])
