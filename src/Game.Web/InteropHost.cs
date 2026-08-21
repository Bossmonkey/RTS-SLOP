using Game.Core;
using Microsoft.JSInterop;

namespace Game.Web;

/// <summary>
/// Static interop target for the Three.js view layer.
///
/// Blazor WASM's JS-side API (window.DotNet.invokeMethod) calls STATIC
/// [JSInvokable] methods by assembly name — it does not marshal a
/// DotNetObjectReference for per-frame use. So the sim lives here as a
/// singleton and the JS rAF loop calls OnFrame(assemblyName, "OnFrame", dtMs)
/// synchronously every frame (the same mechanism Blazor uses internally).
/// </summary>
public static class InteropHost
{
    // Single source of truth for the running simulation. 400u map, 150 units
    // per army -> 300 total ("hundreds of units" scope).
    private const int MaxUnitsPerTeam = 4096; // must match InstancedMesh capacity in game.js

    private static readonly GameWorld World = new(mapSize: 400f, unitsPerArmy: 150);

    // Pre-allocated snapshot buffers (reused every frame -> no per-frame GC).
    private static readonly float[] PX = new float[MaxUnitsPerTeam];
    private static readonly float[] PZ = new float[MaxUnitsPerTeam];
    private static readonly float[] PH = new float[MaxUnitsPerTeam];
    private static readonly float[] EX = new float[MaxUnitsPerTeam];
    private static readonly float[] EZ = new float[MaxUnitsPerTeam];
    private static readonly float[] EH = new float[MaxUnitsPerTeam];

    /// <summary>Called from JS once per frame (synchronously). Ticks the sim and returns unit snapshots.</summary>
    [JSInvokable]
    public static object OnFrame(double dtMs)
    {
        World.Tick((float)(dtMs / 1000.0));

        World.FillTeam(Team.Player, PX, PZ, PH, out var pn);
        World.FillTeam(Team.Enemy, EX, EZ, EH, out var en);

        // Returned to JS as typed arrays (Blazor marshals float[] -> Float32Array).
        return new { PN = pn, EN = en, PX, PZ, PH, EX, EZ, EH };
    }

    /// <summary>One-time info for the HUD / console (not per-frame).</summary>
    [JSInvokable]
    public static object GetInfo() => new { Units = World.Units.Count, MapSize = (int)World.MapSize };
}
