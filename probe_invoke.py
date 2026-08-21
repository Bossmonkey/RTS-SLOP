import os, time
from playwright.sync_api import sync_playwright

CHROME = "/opt/data/sc-rtts/chromium/chrome-linux/headless_shell"
URL = "http://127.0.0.1:8560/"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, headless=True, args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto(URL, wait_until="load")

    # Phase 1: poll until the Blazor runtime has set its call dispatcher.
    # While booting, invokeMethod throws "No call dispatcher has been set."
    ready = False
    t0 = time.time()
    while time.time() - t0 < 90:
        try:
            pg.evaluate("window.DotNet.invokeMethod('Game.Web','GetInfo')")
            ready = True  # resolved (or threw a non-boot error) -> dispatcher is set
            break
        except Exception as e:
            if "No call dispatcher" in str(e):
                pass  # still booting
            else:
                ready = True  # some other error means the runtime IS up
                break
        pg.wait_for_timeout(1500)

    print(f"dispatcher ready after {time.time()-t0:.1f}s (ready={ready})")
    if not ready:
        print("NEVER READY. console errors:")
        for e in errs[-15:]:
            print("   ", e[:200])
        b.close()
        raise SystemExit(1)

    # Phase 2: learn the method-name resolution convention empirically.
    probe = """
    () => {
      const out = {};
      const cands = [
        ["Game.Web", "GetInfo"],
        ["Game.Web.InteropHost", "GetInfo"],
        ["InteropHost", "GetInfo"]
      ];
      for (const [a, m] of cands) {
        try {
          const r = window.DotNet.invokeMethod(a, m);
          out[a + "." + m] = "OK -> " + JSON.stringify(r).slice(0, 120);
        } catch (e) {
          out[a + "." + m] = "ERR: " + String(e.message || e).slice(0, 140);
        }
      }
      return out;
    }
    """
    res = pg.evaluate(probe)
    print("=== invokeMethod resolution probe ===")
    for k, v in res.items():
        print(f"  {k:35s} {v}")

    # Phase 3: if a format worked, confirm OnFrame returns real snapshot data.
    ok_fmt = [k for k, v in res.items() if v.startswith("OK")]
    if ok_fmt:
        a, m = ok_fmt[0].rsplit(".", 1)
        try:
            snap = pg.evaluate(f"window.DotNet.invokeMethod('{a}','OnFrame',16)")
            keys = list(snap.keys()) if isinstance(snap, dict) else type(snap).__name__
            print(f"\n=== OnFrame via {ok_fmt[0]} ===")
            print("  keys:", keys)
            for k in ("PN", "EN"):
                if isinstance(snap, dict) and k in snap:
                    print(f"  {k} = {snap[k]}")
        except Exception as e:
            print("\nOnFrame failed:", str(e)[:200])

    b.close()
