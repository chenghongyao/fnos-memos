#!/usr/bin/env python3
# 版权与许可：MIT License, Copyright (c) 2026 chenghongyao
# 第三方声明见 app/server/NOTICE
"""memos 飞牛网关功能自检：登录 → 建笔记 → 列表 → 客户端路由 → 深链。

用法: python functional_check.py [base_url] [user] [pass]
"""
import sys, json, pathlib, time
from playwright.sync_api import sync_playwright, expect

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18082/app/Memos").rstrip("/")
USER = sys.argv[2] if len(sys.argv) > 2 else "gwtest"
PWD = sys.argv[3] if len(sys.argv) > 3 else "GwTest@2026"
OUT = pathlib.Path("/vol1/@appshare/Harness/work/dsh-fnos-gateway/memos/tests")
OUT.mkdir(parents=True, exist_ok=True)

report = {"base": BASE, "steps": [], "console_errors": [], "failed_requests": [], "rpc": []}
step = report["steps"]

def attach(page):
    page.on("console", lambda m: report["console_errors"].append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: report["console_errors"].append(f"pageerror: {str(e)[:200]}"))
    page.on("requestfailed", lambda r: report["failed_requests"].append(f"REQFAIL {r.method} {r.url} :: {r.failure}"))
    page.on("response", lambda r: {
        report["failed_requests"].append(f"HTTP {r.status} {r.url}") if r.status >= 400 else None,
        report["rpc"].append(f"{r.status} {r.request.method} {r.url}") if "memos.api." in r.url else None,
    })

def page_text(page):
    try:
        return page.evaluate("() => document.body.innerText || document.body.textContent || \"\"")
    except Exception:
        return ""

def note(name, ok, detail=""):
    step.append({"step": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (f" :: {str(detail)[:160]}" if detail else ""))

def login(page):
    for attempt in range(5):
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(4500)
        if page.get_by_role("button", name="Create admin account").count():
            page.get_by_label("Username").fill(USER)
            page.get_by_label("Password").fill(PWD)
            page.get_by_role("button", name="Create admin account").click()
            page.wait_for_timeout(4500)
            return "signup"
        if page.get_by_role("button", name="Sign in").count():
            page.get_by_label("Username").fill(USER)
            page.get_by_label("Password").fill(PWD)
            page.get_by_role("button", name="Sign in").click()
            page.wait_for_timeout(4500)
            if "/auth" not in page.url:
                return "signin"
            time.sleep(1)
            continue
        if "/auth" not in page.url:
            return "already"
        # 表单还没渲染出来，等一会儿再来
        time.sleep(1.5)
    return "failed"

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1360, "height": 900})
    page = ctx.new_page()
    attach(page)

    # ---- 1. 首屏 ----
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(4000)
    body = page_text(page)
    note("首屏渲染", "Memos" in body, page.url)
    has_shim = page.evaluate("() => typeof window.__memosGatewayFix") == "function"
    # TCP 入口在站点根，不需要前缀补丁；网关入口需要
    if "/app/Memos" in BASE:
        note("运行时补丁已注入", has_shim, page.evaluate("() => typeof window.__memosGatewayFix"))
    else:
        note("站点根模式（无需前缀补丁）", not has_shim, page.evaluate("() => typeof window.__memosGatewayFix"))
    page.screenshot(path=str(OUT / "f01-firstrun.png"))

    # ---- 2. 登录 ----
    how = login(page)
    page.wait_for_timeout(2000)
    note(f"登录（{how}）", "/auth" not in page.url, page.url)
    page.screenshot(path=str(OUT / "f02-after-login.png"))

    # ---- 3. 首页 / Explore 深链 ----
    for path, label in (("/home", "home"), ("/explore", "explore")):
        page.goto(BASE + path, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3500)
        txt = page_text(page)
        note(f"{label} 页面渲染", len(txt) > 30 and "/auth" not in page.url, page.url)
        page.screenshot(path=str(OUT / f"f03-{label}.png"))

    # ---- 4. 新建笔记 ----
    page.goto(BASE + "/home", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(3500)
    memo_text = "网关自检笔记 gateway-self-test"
    created = False
    try:
        editors = page.locator("textarea, [contenteditable=true]")
        print("   editors found:", editors.count())
        ed = None
        for i in range(editors.count()):
            cand = editors.nth(i)
            try:
                if cand.is_visible():
                    ed = cand
                    break
            except Exception:
                pass
        if ed is None:
            raise RuntimeError("没有可见的笔记编辑器")
        ed.click(timeout=8000)
        ed.fill(memo_text)
        page.wait_for_timeout(800)
        page.get_by_role("button", name="Save").first.click(timeout=8000)
        page.wait_for_timeout(4000)
        created = memo_text in page_text(page)
    except Exception as e:
        note("新建笔记异常", False, str(e)[:220])
    note("新建笔记", created, page.url)
    page.screenshot(path=str(OUT / "f04-memo-created.png"))

    # ---- 5. 客户端路由（不整页刷新） ----
    page.goto(BASE + "/home", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(3500)
    page.evaluate("() => { window.__noReload = true; }")
    nav_ok = False
    try:
        page.get_by_text(memo_text, exact=False).first.click(timeout=8000)
        page.wait_for_timeout(2500)
        nav_ok = page.evaluate("() => window.__noReload === true")
    except Exception as e:
        note("客户端路由异常", False, str(e)[:200])
    note("客户端路由（无整页刷新）", nav_ok, page.url)
    page.screenshot(path=str(OUT / "f05-client-nav.png"))

    # ---- 6. 刷新后深链依然正确 ----
    page.goto(BASE + "/explore", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(3500)
    note("深链 /explore 可直接访问", len(page.inner_text("body")) > 30 and "/auth" not in page.url, page.url)

    b.close()

print("\n=== RPC 调用（去重） ===")
seen = set()
for r in report["rpc"]:
    if r not in seen:
        seen.add(r)
        print("  ", r)
print("\n=== 失败请求（去重） ===")
seen = set()
for f in report["failed_requests"]:
    if f not in seen:
        seen.add(f)
        print("  ", f)
print("\n=== console errors ===")
for c in report["console_errors"][:12]:
    print("  ", c[:200])

(OUT / "functional-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
fails = [s for s in step if not s["ok"]]
print(f"\n结果：{len(step) - len(fails)}/{len(step)} 通过")
