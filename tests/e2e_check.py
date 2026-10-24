#!/usr/bin/env python3
"""memos 飞牛网关端到端自检（本地调试模式）。

用法: python e2e_check.py [base_url]
默认 base_url = http://127.0.0.1:18081/app/Memos
"""
import sys, json, pathlib
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18081/app/Memos").rstrip("/")
OUT = pathlib.Path("/vol1/@appshare/Harness/work/dsh-fnos-gateway/memos/tests")
OUT.mkdir(parents=True, exist_ok=True)

report = {"base": BASE, "pages": [], "console_errors": [], "failed_requests": []}

def attach(page):
    page.on("console", lambda m: report["console_errors"].append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("requestfailed", lambda r: report["failed_requests"].append(f"{r.method} {r.url} :: {r.failure}"))
    page.on("response", lambda r: report["failed_requests"].append(f"HTTP {r.status} {r.url}") if r.status >= 400 else None)

def visit(page, path, name, wait=2500):
    url = BASE + path
    errs_before = len(report["console_errors"])
    fails_before = len(report["failed_requests"])
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(wait)
    info = {
        "path": path,
        "url": page.url,
        "title": page.title(),
        "body_len": len(page.content()),
        "text": page.inner_text("body")[:300].replace("\n", " | "),
        "new_console": report["console_errors"][errs_before:],
        "new_failed": report["failed_requests"][fails_before:],
    }
    try:
        page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)
    except Exception as e:
        info["screenshot_error"] = str(e)
    report["pages"].append(info)
    print(f"--- {path} -> {page.url}")
    print("   title:", info["title"])
    print("   text :", info["text"][:200])
    if info["new_console"]:
        print("   console:", info["new_console"][:5])
    if info["new_failed"]:
        print("   failed :", info["new_failed"][:5])
    return info

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1360, "height": 900})
    page = ctx.new_page()
    attach(page)

    visit(page, "/", "01-home")
    visit(page, "/explore", "02-explore")
    visit(page, "/auth", "03-auth")

    # 客户端路由：点击导航（不重新加载整页）
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)
    print("--- client-side navigation test")
    for label in ("Explore", "Home", "About"):
        try:
            el = page.get_by_text(label, exact=True).first
            el.click(timeout=5000)
            page.wait_for_timeout(1500)
            print(f"   click {label} -> {page.url}")
            report["pages"].append({"click": label, "url": page.url})
        except Exception as e:
            print(f"   click {label} failed: {str(e)[:120]}")
            report["pages"].append({"click": label, "error": str(e)[:200]})
    try:
        page.screenshot(path=str(OUT / "04-after-click.png"))
    except Exception:
        pass

    b.close()

print("\n=== REPORT ===")
print(json.dumps(report, ensure_ascii=False, indent=2)[:6000])
(OUT / "e2e-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print("\nreport saved:", OUT / "e2e-report.json")
