"""Verify ScRtts Phase 0 in a real headless browser.

Boots the Blazor WASM app, captures console/errors, waits for the game loop to
start, then reports FPS + unit counts + camera state and saves screenshots at
two zoom levels (strategic default, and after simulating wheel-zoom-in).
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8560/"
OUT = "/opt/data/sc-rtts/verify"
# Locally-downloaded headless Chromium (Playwright CDN is blocked on this host).
CHROME = os.environ.get(
    "SCRTTS_CHROME",
    "/opt/data/sc-rtts/chromium/chrome-linux/headless_shell",
)

def main():
    console_msgs, page_errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=CHROME,
            args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
        )
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        print("navigating...")
        page.goto(URL, wait_until="domcontentloaded")

        # Wait for the .NET runtime to finish booting (window.DotNet appears).
        try:
            page.wait_for_function(
                "typeof window.DotNet !== 'undefined' && !!window.DotNet.invokeMethod",
                timeout=120_000,
            )
            print(".NET runtime booted")
        except Exception as e:
            print(f"FAIL: .NET runtime did not boot in time: {e}")

        # Wait for the game loop to start AND units to actually render (proves
        # the C#->JS snapshot path is working, not just that rAF started).
        try:
            page.wait_for_function(
                "window.ScRtts && window.__scrtts && window.__scrtts.running === true"
                " && window.__scrtts.counts.player > 0",
                timeout=60_000,
            )
            print("game loop running + units rendering")
        except Exception as e:
            print(f"FAIL: game loop did not start/render: {e}")

        # Let it run a few seconds so FPS stabilizes and units move.
        page.wait_for_timeout(6000)

        stats = page.evaluate("window.ScRtts.getStats()")
        perf_text = page.text_content("#perf") or ""
        print(f"STATS: {json.dumps(stats)}")
        print(f"PERF : {perf_text}")

        import os
        os.makedirs(OUT, exist_ok=True)
        page.screenshot(path=f"{OUT}/strategic.png")
        print("screenshot -> strategic.png")

        # Simulate zooming in (wheel up = deltaY negative) to test the SC camera.
        for _ in range(14):
            page.mouse.wheel(0, -240)
            page.wait_for_timeout(60)
        page.wait_for_timeout(800)
        stats2 = page.evaluate("window.ScRtts.getStats()")
        print(f"STATS after zoom-in: {json.dumps(stats2)}")
        page.screenshot(path=f"{OUT}/tactical.png")
        print("screenshot -> tactical.png")

        # Pan test: left-drag.
        page.mouse.move(800, 450)
        page.mouse.down()
        page.mouse.move(1000, 350, steps=10)
        page.mouse.up()
        page.wait_for_timeout(400)
        stats3 = page.evaluate("window.ScRtts.getStats()")
        print(f"STATS after pan: {json.dumps(stats3)}")

        browser.close()

    print("\n=== CONSOLE (last 25) ===")
    for m in console_msgs[-25:]:
        print(m)
    print("\n=== PAGE ERRORS ===")
    if page_errors:
        for e in page_errors:
            print(e)
    else:
        print("(none)")

    # Verdict
    ok = (not page_errors) and stats.get("running") and stats["units"]["player"] > 0
    print("\nVERDICT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
