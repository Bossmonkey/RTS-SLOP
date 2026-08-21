import os
from playwright.sync_api import sync_playwright

CHROME = "/opt/data/sc-rtts/chromium/chrome-linux/headless_shell"
URL = "http://127.0.0.1:8560/"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=CHROME,
                          args=["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    pg.goto(URL, wait_until="domcontentloaded")
    try:
        # Wait for EITHER casing of the interop global to appear.
        pg.wait_for_function(
            "typeof window.DotNet !== 'undefined' || typeof window.dotnet !== 'undefined'",
            timeout=90_000)
        print("interop global appeared")
    except Exception as e:
        print("NO interop global in 90s:", str(e)[:120])

    probe = pg.evaluate("""() => {
      const out = {};
      for (const name of ['DotNet', 'dotnet']) {
        const g = window[name];
        if (g) {
          out[name] = {
            type: typeof g,
            ownKeys: Object.getOwnPropertyNames(g),
            methods: Object.getOwnPropertyNames(g).filter(k => typeof g[k] === 'function'),
          };
        } else {
          out[name] = null;
        }
      }
      // Any other interop-ish globals?
      out.interopGlobals = Object.getOwnPropertyNames(window).filter(k => /dotnet|blazor|interop/i.test(k));
      return out;
    }""")
    import json
    print("PROBE:", json.dumps(probe, indent=2))

    print("\n=== console tail ===")
    for l in logs[-15:]:
        print(l)
    b.close()
