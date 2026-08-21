# ScRtts — a Blazor WASM RTS (Supreme Commander–style camera)

A learning demo of a 3D real-time strategy game built with **Blazor WebAssembly**
and **Three.js**, in the spirit of *Supreme Commander*: dramatic ground-to-
strategic zoom, GPU-instanced armies marching across a large map.

> **Phase 0 (current):** proof-of-concept pipeline — two instanced armies
> (~300 units) march toward each other under an SC-style camera. No combat or
> building yet; the goal is to validate rendering + interop at scale before
> adding game systems.

## Architecture

The single most important rule: **Blazor never touches the 60fps hot path.**

```
┌─────────────────────────── Browser ───────────────────────────────┐
│                                                                   │
│   Three.js view (JS)                Blazor WASM (C#)              │
│   ┌─────────────────────┐           ┌─────────────────────────┐  │
│   │ requestAnimationFrame│  sync    │ GameCanvas.razor        │  │
│   │ loop owns the frame │◄──────────│  [JSInvokable] OnFrame  │  │
│   │                     │  invoke   │         │               │  │
│   │ InstancedMesh ×2    │           │         ▼               │  │
│   │ (hull + turret)     │           │ GameWorld.Tick(dt)      │  │
│   │ SC-style camera     │           │ (pure C# sim core)      │  │
│   └─────────────────────┘           └─────────────────────────┘  │
│            ▲                              │                       │
│            └── snapshot arrays ───────────┘                       │
│                                                                   │
│   HUD chrome (Blazor components, static — rendered once)          │
└───────────────────────────────────────────────────────────────────┘
```

- **`Game.Core`** — pure C# simulation. No rendering, no UI, no `DateTime.Now`.
  It advances only when you call `Tick(dt)`. This separation is deliberate: the
  same world can later run on a server and be serialized to clients for
  multiplayer without touching game logic.
- **`Game.Web`** — Blazor WASM host + Three.js view. JS owns the rAF loop (real
  vsync). Each frame it calls `OnFrame(dtMs)` *synchronously* via
  `dotnet.invokeMethod`, which ticks the sim and returns pre-allocated snapshot
  arrays (marshaled to typed arrays). Blazor components render only static HUD
  chrome — never per-frame data.

### Why synchronous interop?

`invokeMethod` (in-process) is a blocking call with no async overhead, so one
round-trip per frame at 60fps costs well under a millisecond for ~300 units.
If we ever push into thousands of units, the swap path is: unmarshalled typed-
array interop or moving the sim to a Web Worker — `Game.Core` won't change.

## The Supreme Commander camera

Zoom drives **both** distance and pitch on a smoothstep curve:

| Zoom | Distance | Pitch | Feel |
|------|----------|-------|------|
| In   | ~25u     | ~31°  | Tactical, ground-level |
| Out  | ~1400u   | ~81°  | Strategic, near top-down |

Fog density also scales with altitude so the world fades into the void at
strategic zoom — a big part of why SC maps *feel* enormous.

## Controls

- **Left-drag** — pan
- **Right-drag** — rotate (orbit)
- **Wheel** — zoom (ground ⇄ strategic)
- **R** — reset camera

## Project layout

```
ScRtts.sln
├── src/
│   ├── Game.Core/            # pure C# sim (multiplayer-ready core)
│   │   ├── Vec3.cs           # minimal 3D vector (no deps, serializable)
│   │   ├── Unit.cs           # unit entity + team enum
│   │   └── GameWorld.cs      # map, army spawn, Tick(), spatial-hash separation
│   └── Game.Web/             # Blazor WASM host + Three.js view
│       ├── GameCanvas.razor  # interop bridge (OnFrame), owns the sim instance
│       ├── Layout/MainLayout.razor   # static HUD chrome
│       ├── Pages/Home.razor          # mounts <GameCanvas/>
│       └── wwwroot/
│           ├── index.html    # full-viewport canvas; three.js loads pre-.NET
│           ├── js/game.js    # scene, instanced armies, camera, input, rAF loop
│           ├── lib/three/    # vendored three.min.js (r128 global build)
│           └── css/app.css   # HUD styling
├── verify.py                 # headless-browser smoke test (Playwright)
└── .gitignore
```

## Build & run

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).

```bash
# develop (hot reload via dev server)
dotnet run --project src/Game.Web

# or publish a static site and serve it any way you like
dotnet publish src/Game.Web -c Release -o publish
cd publish/wwwroot && python3 -m http.server 8080
```

Open the URL, wait for the WASM runtime to boot (~10–20s first load), and two
armies will be marching at each other.

## Verification

`verify.py` boots the app in headless Chromium (SwiftShader software GL), waits
for the game loop, then checks FPS/unit counts/camera state and screenshots two
zoom levels:

```bash
uv venv .venv && . .venv/bin/activate
uv pip install playwright
python -m playwright install chromium-headless-shell
python verify.py   # prints STATS + VERDICT PASS/FAIL
```

## Roadmap (phases)

- [x] **Phase 0** — pipeline proof: Blazor WASM shell, Three.js scene, instanced
      armies, SC-style zoom camera, C#↔JS interop at 60fps.
- [ ] **Phase 1** — core loop: resources, base building (placement + queues),
      unit production, box-select and move orders.
- [ ] **Phase 2** — combat + AI: damage/death, a basic enemy that builds and
      attacks, win/lose conditions.
- [ ] **Phase 3** — the SC feel: full LOD (models → billboards → minimap dots),
      fog of war, tech tree, strategic-zoom minimap.
- [ ] **Phase 4 (optional)** — multiplayer: server-authoritative sim over the
      existing `Game.Core` (lockstep or state-sync). Deferred until single-player
      is solid.

## Notes & known limitations

- Three.js r128 global build, vendored locally (no CDN dependency at runtime).
  A newer module build + import map would be a drop-in upgrade if needed.
- Units are procedural hex hulls + turret boxes — no art assets yet.
- Separation uses a spatial hash; fine for hundreds of units on the main thread.
  Flow fields / workers only become necessary at thousands of units.
