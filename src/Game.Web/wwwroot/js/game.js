// ============================================================================
// ScRtts view layer (Three.js) — Phase 0 proof of concept
// ----------------------------------------------------------------------------
// Architecture rule: JS owns the requestAnimationFrame loop (real vsync).
// Each frame it calls into C# *synchronously* via dotnet.invokeMethod, which
// ticks the pure-C# GameWorld and returns pre-allocated Float32Array buffers
// BY REFERENCE. No per-frame allocation on either side, no async races.
// Blazor components never touch this hot path — they only render static HUD.
// ============================================================================

(function () {
  'use strict';

  const state = {
    renderer: null,
    scene: null,
    camera: null,
    meshes: {},          // team -> { hull, turret }
    counts: { player: 0, enemy: 0 },
    mapSize: 400,
    rafId: 0,
    running: false,
    // Blazor WASM exposes its interop API on window.DotNet (capital D).
    canSync: !!(window.DotNet && typeof window.DotNet.invokeMethod === 'function'),

    // Camera (Supreme Commander style: zoom drives both distance AND pitch)
    cam: { targetX: 0, targetZ: 0, yaw: Math.PI / 2, dist: 380 },
    camMinDist: 25,
    camMaxDist: 1400,

    // Input
    dragging: null,      // 'pan' | 'rotate'
    lastX: 0, lastY: 0,

    // Perf meter (JS writes directly to its own DOM node — deliberately NOT
    // routed through Blazor's render cycle)
    frames: 0, fpsTime: 0, perfEl: null,
  };

  const TEAM_COLORS = { player: 0x35d6ff, enemy: 0xff5a3c };

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  // Smoothstep for the pitch curve so zoom feels organic, not linear.
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  // --------------------------------------------------------------------------
  // Scene setup
  // --------------------------------------------------------------------------

  function makeGridTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#0a0f16';
    g.fillRect(0, 0, 64, 64);
    // Minor grid line on right + bottom edges (tiles seamlessly)
    g.strokeStyle = 'rgba(90, 130, 170, 0.28)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(63.5, 0); g.lineTo(63.5, 64);
    g.moveTo(0, 63.5); g.lineTo(64, 63.5);
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function buildScene() {
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x05070c);
    state.scene.fog = new THREE.FogExp2(0x05070c, 0.0016);

    // Lights: cool sky / dark ground + a key light for shape.
    const hemi = new THREE.HemisphereLight(0x8fb4d9, 0x0a0e14, 0.9);
    state.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xbfd9ff, 0.7);
    dir.position.set(-200, 300, -150);
    state.scene.add(dir);

    // Ground: one big plane with a tiling grid texture (procedural — no assets).
    const mapSize = state.mapSize;
    const groundGeo = new THREE.PlaneGeometry(mapSize * 4, mapSize * 4, 1, 1);
    const gridTex = makeGridTexture();
    const cells = (mapSize * 4) / 20; // one texture cell == 20 world units
    gridTex.repeat.set(cells, cells);
    const groundMat = new THREE.MeshLambertMaterial({ map: gridTex });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    state.scene.add(ground);

    // Units: per team -> hex hull (elongated in Z so heading reads at distance)
    // + a turret box pre-translated up so both share the same instance matrix.
    const hullGeo = new THREE.CylinderGeometry(1.3, 1.5, 0.9, 6);
    const turretGeo = new THREE.BoxGeometry(1.2, 0.5, 1.8);
    turretGeo.translate(0, 1.0, 0);

    for (const team of ['player', 'enemy']) {
      const mat = new THREE.MeshLambertMaterial({ color: TEAM_COLORS[team] });
      // Slight emissive so units stay visible in fog at strategic zoom.
      mat.emissive = new THREE.Color(TEAM_COLORS[team]);
      mat.emissiveIntensity = 0.25;

      const hull = new THREE.InstancedMesh(hullGeo, mat, 4096);
      const turret = new THREE.InstancedMesh(turretGeo, mat.clone(), 4096);
      // Emissive on the cloned material too.
      turret.material.emissive = new THREE.Color(TEAM_COLORS[team]);
      turret.material.emissiveIntensity = 0.25;

      hull.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      turret.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      state.scene.add(hull, turret);
      state.meshes[team] = { hull, turret };
    }
  }

  // --------------------------------------------------------------------------
  // Camera — the Supreme Commander zoom: distance and pitch are coupled.
  // Close in -> low angle, tactical. Zoomed out -> near top-down, strategic.
  // --------------------------------------------------------------------------

  function updateCamera() {
    const c = state.cam;
    const t = smooth((c.dist - state.camMinDist) / (state.camMaxDist - state.camMinDist));
    const pitch = lerp(0.55, 1.42, t); // ~31 deg -> ~81 deg

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
    state.camera.position.set(
      c.targetX + sy * cp * c.dist,
      sp * c.dist,
      c.targetZ + cy * cp * c.dist
    );
    state.camera.lookAt(c.targetX, 0, c.targetZ);

    // Fog thickens with altitude: the world fades into the void when zoomed out.
    if (state.scene.fog) {
      state.scene.fog.density = lerp(0.0012, 0.0035, t);
    }
  }

  // --------------------------------------------------------------------------
  // Per-frame: pull snapshot from C#, write instance matrices, render.
  // --------------------------------------------------------------------------

  const _m4 = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1.7); // elongate hull along local Z
  const _zeroScale = new THREE.Vector3(0.0001, 0.0001, 0.0001);
  const _Y = new THREE.Vector3(0, 1, 0);

  function writeTeam(team, xs, zs, hs, count) {
    const { hull, turret } = state.meshes[team];
    for (let i = 0; i < count; i++) {
      _pos.set(xs[i], 0.45, zs[i]);
      // C# heading: atan2(dirX, dirZ) -> rotation about +Y by that angle maps
      // local +Z to the travel direction. Exactly what we want.
      _quat.setFromAxisAngle(_Y, hs[i]);
      _m4.compose(_pos, _quat, _scale);
      hull.setMatrixAt(i, _m4);
      turret.setMatrixAt(i, _m4);
    }
    // Hide unused instances (meshes are allocated for 4096 max).
    const prev = state.counts[team];
    for (let i = count; i < Math.max(count + 1, prev); i++) {
      _pos.set(0, -1000, 0);
      _quat.identity();
      _m4.compose(_pos, _quat, _zeroScale);
      hull.setMatrixAt(i, _m4);
      turret.setMatrixAt(i, _m4);
    }
    state.counts[team] = count;
    hull.instanceMatrix.needsUpdate = true;
    turret.instanceMatrix.needsUpdate = true;
  }

  function applySnapshot(snap) {
    // Blazor interop lowercases the returned property names (PN -> pn, PX -> px).
    writeTeam('player', snap.px, snap.pz, snap.ph, snap.pn);
    writeTeam('enemy', snap.ex, snap.ez, snap.eh, snap.en);
  }

  // --------------------------------------------------------------------------
  // Input: left-drag pan, right-drag rotate, wheel zoom, R reset.
  // --------------------------------------------------------------------------

  function bindInput(canvas) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('mousedown', (e) => {
      state.dragging = e.button === 2 ? 'rotate' : 'pan';
      state.lastX = e.clientX;
      state.lastY = e.clientY;
    });

    window.addEventListener('mouseup', () => { state.dragging = null; });

    window.addEventListener('mousemove', (e) => {
      if (!state.dragging) return;
      const dx = e.clientX - state.lastX;
      const dy = e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;

      const c = state.cam;
      if (state.dragging === 'rotate') {
        c.yaw += dx * 0.005;
      } else {
        // Pan in the camera's ground plane. Farther zoom -> faster pan.
        const unitsPerPx = c.dist * 0.0016;
        const sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
        // Camera forward (projected to ground) and right vectors:
        const fx = -sy, fz = -cy;          // toward target
        const rx = cy, rz = -sy;           // camera right
        c.targetX += (-dx * rx + dy * fx) * unitsPerPx;
        c.targetZ += (-dx * rz + dy * fz) * unitsPerPx;
        // Keep the focus inside a generous bound around the map.
        const b = state.mapSize;
        c.targetX = clamp(c.targetX, -b, b);
        c.targetZ = clamp(c.targetZ, -b, b);
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const c = state.cam;
      c.dist *= Math.exp(e.deltaY * 0.0012);
      c.dist = clamp(c.dist, state.camMinDist, state.camMaxDist);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'r' || e.key === 'R') resetCamera();
    });
  }

  function resetCamera() {
    state.cam.targetX = 0;
    state.cam.targetZ = 0;
    state.cam.yaw = Math.PI / 2;
    state.cam.dist = 380;
  }

  // --------------------------------------------------------------------------
  // Perf meter — JS-owned DOM node, updated ~2x/sec. Intentionally bypasses
  // Blazor's diffing (per-frame HUD updates through components would crawl).
  // --------------------------------------------------------------------------

  function updatePerf(now) {
    state.frames++;
    if (now - state.fpsTime >= 500) {
      const fps = Math.round(state.frames * 1000 / (now - state.fpsTime));
      state.frames = 0;
      state.fpsTime = now;
      if (state.perfEl) {
        const c = state.cam;
        state.perfEl.textContent =
          `${fps} fps · ${state.counts.player + state.counts.enemy} units · ` +
          `cam h=${Math.round(c.dist * Math.sin(1.42))}m`;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------------

  let lastT = 0;
  // Assembly + type for the static [JSInvokable] target (InteropHost).
  const DOTNET_ASSEMBLY = 'Game.Web';

  // window.DotNet only exists AFTER Blazor boots, so availability must be
  // checked lazily — poll each frame until the runtime is up, then cache true.
  let dotnetReady = false;
  function dotnetAvailable() {
    if (!dotnetReady)
      dotnetReady = !!(window.DotNet && typeof window.DotNet.invokeMethod === 'function');
    return dotnetReady;
  }

  function frame(t) {
    if (!state.running) return;
    state.rafId = requestAnimationFrame(frame);

    const dtMs = Math.min(Math.max(t - lastT, 0), 100);
    lastT = t;

    // One round-trip per frame: tick sim + get snapshot buffers.
    if (dotnetAvailable()) {
      let snap;
      try {
        const r = window.DotNet.invokeMethod(DOTNET_ASSEMBLY, 'OnFrame', dtMs);
        // invokeMethod is synchronous in WASM; guard against a Promise just in case.
        snap = (r && typeof r.then === 'function') ? null : r;
        if (snap) applySnapshot(snap);
      } catch (err) {
        console.error('[ScRtts] OnFrame failed:', err);
      }
    }

    updateCamera();
    state.renderer.render(state.scene, state.camera);
    updatePerf(t);
  }

  // --------------------------------------------------------------------------
  // Public API (called from C# via IJSRuntime)
  // --------------------------------------------------------------------------

  window.ScRtts = {
    /**
     * @param {string} canvasId id of the <canvas> element
     * @param {{mapSize:number}} opts
     */
    init(canvasId, opts) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) throw new Error('ScRtts.init: canvas #' + canvasId + ' not found');
      state.mapSize = (opts && opts.mapSize) || 400;

      try {
        state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      } catch (err) {
        console.error('[ScRtts] WebGL init failed:', err);
        throw err;
      }
      state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      const resize = () => {
        const w = window.innerWidth, h = window.innerHeight;
        state.renderer.setSize(w, h, false);
        state.camera.aspect = w / h;
        state.camera.updateProjectionMatrix();
      };
      state.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 6000);
      window.addEventListener('resize', resize);
      resize();

      buildScene();
      bindInput(canvas);

      const perfEl = document.getElementById('perf');
      if (perfEl) state.perfEl = perfEl;

      console.log('[ScRtts] view ready — mapSize=' + state.mapSize +
        ', syncInterop=' + state.canSync +
        ', webgl=' + (state.renderer.capabilities ? 'ok' : '?'));
      return { ok: true, canSync: state.canSync };
    },

    /** Start the rAF loop. The sim tick goes through static InteropHost.OnFrame. */
    startLoop() {
      if (state.running) return;

      // One-time diagnostic: confirm sync interop works and the static method resolves.
      try {
        const r0 = window.DotNet.invokeMethod(DOTNET_ASSEMBLY, 'GetInfo');
        console.log('[ScRtts] startLoop canSync=' + state.canSync +
          ' GetInfo -> ' + JSON.stringify(r0));
      } catch (err) {
        console.error('[ScRtts] startLoop static probe failed:', err);
      }

      state.running = true;
      lastT = performance.now();
      state.fpsTime = lastT;
      state.rafId = requestAnimationFrame(frame);
    },

    stopLoop() {
      state.running = false;
      if (state.rafId) cancelAnimationFrame(state.rafId);
    },

    /** Debug hook: current camera + perf info as plain JSON. */
    getStats() {
      const c = state.cam;
      return {
        running: state.running,
        canSync: dotnetAvailable(),
        units: { player: state.counts.player, enemy: state.counts.enemy },
        cam: { x: +c.targetX.toFixed(1), z: +c.targetZ.toFixed(1), yaw: +c.yaw.toFixed(2), dist: Math.round(c.dist) },
      };
    },
  };

  // Expose internals for debugging from the console.
  window.__scrtts = state;
})();
