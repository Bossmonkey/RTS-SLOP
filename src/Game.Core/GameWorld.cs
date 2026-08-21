using System.Collections.Generic;

namespace Game.Core;

/// <summary>
/// The whole game state + rules. Pure C#: no rendering, no UI, no time-of-day
/// calls — it advances only when you call <see cref="Tick"/> with a delta.
/// That separation is what makes multiplayer possible later (the same world can
/// run on a server and be serialized to clients).
/// </summary>
public sealed class GameWorld
{
    public float MapSize { get; }          // square map, centered at origin: [-MapSize/2, +MapSize/2]
    public int UnitsPerArmy { get; }

    private readonly List<Unit> _units = new();
    private readonly Random _rng;

    /// <summary>Where each team marches to (the enemy's front line).</summary>
    private Vec3 _playerTarget;
    private Vec3 _enemyTarget;

    // Spatial hash for cheap neighbor lookups during separation.
    private const float CellSize = 6f;
    private Dictionary<(int, int), List<Unit>>? _grid;

    public GameWorld(float mapSize = 400f, int unitsPerArmy = 150, int seed = 1337)
    {
        MapSize = mapSize;
        UnitsPerArmy = unitsPerArmy;
        _rng = new Random(seed);

        var half = mapSize / 2f;
        // Armies spawn near opposite edges and march toward the center.
        SpawnArmy(Team.Player, new Vec3(-half + 40f, 0f, 0f));
        SpawnArmy(Team.Enemy,   new Vec3( half - 40f, 0f, 0f));

        _playerTarget = new Vec3(half * 0.25f, 0f, 0f);
        _enemyTarget  = new Vec3(-half * 0.25f, 0f, 0f);
    }

    public IReadOnlyList<Unit> Units => _units;

    private void SpawnArmy(Team team, Vec3 origin)
    {
        // Grid formation: 10 columns x N rows, facing the enemy.
        const int cols = 10;
        var spacing = 5f;
        var facing = team == Team.Player ? 0f : MathF.PI; // yaw toward +X or -X

        for (var i = 0; i < UnitsPerArmy; i++)
        {
            var col = i % cols;
            var row = i / cols;
            _units.Add(new Unit
            {
                Id = team == Team.Player ? i : 10_000 + i,
                Team = team,
                Position = new Vec3(
                    origin.X + (col - cols / 2f) * spacing,
                    0f,
                    origin.Z + (row - UnitsPerArmy / cols / 2f) * spacing),
                Heading = facing,
                MaxSpeed = 14f + _rng.NextSingle() * 6f,   // 14-20 u/s with jitter
                WobblePhase = _rng.NextSingle() * MathF.Tau,
            });
        }
    }

    /// <summary>Advance the simulation by dt seconds. Call once per frame.</summary>
    public void Tick(float dt)
    {
        if (dt <= 0f) return;
        // Clamp so a hiccup (tab switch etc.) can't teleport units across the map.
        dt = MathF.Min(dt, 0.1f);

        RebuildGrid();

        foreach (var u in _units)
        {
            if (!u.Alive) continue;

            var target = u.Team == Team.Player ? _playerTarget : _enemyTarget;
            var toTarget = target - u.Position;
            var distToTarget = toTarget.Length();

            Vec3 desired;
            if (distToTarget > 4f)
            {
                // March toward the front line.
                desired = toTarget.Normalized() * u.MaxSpeed;
            }
            else
            {
                // Arrived: hold position with a gentle idle wobble so the army
                // reads as "alive" rather than frozen.
                var t = _time + u.WobblePhase;
                desired = new Vec3(MathF.Cos(t) * 0.6f, 0f, MathF.Sin(t) * 0.6f);
            }

            // Separation: push away from nearby allies so ranks don't collapse.
            var sep = Separation(u);
            desired += sep;

            // Integrate (units stay on the ground plane).
            u.Position = u.Position + desired * dt;

            // Keep inside the map (Vec3 is immutable -> rebuild, don't mutate fields).
            var half = MapSize / 2f - 4f;
            var p = u.Position;
            if (p.X >  half) p = new Vec3( half, p.Y, p.Z);
            else if (p.X < -half) p = new Vec3(-half, p.Y, p.Z);
            if (p.Z >  half) p = new Vec3(p.X, p.Y,  half);
            else if (p.Z < -half) p = new Vec3(p.X, p.Y, -half);
            u.Position = p;

            // Face the direction of travel when actually moving.
            var speed = desired.Length();
            if (speed > 1f)
                u.Heading = MathF.Atan2(desired.X, desired.Z);
        }

        _time += dt;
    }

    private float _time;

    /// <summary>Sum of repulsion vectors from nearby allies.</summary>
    private Vec3 Separation(Unit self)
    {
        var result = Vec3.Zero;
        if (_grid is null) return result;

        var cx = (int)MathF.Floor(self.Position.X / CellSize);
        var cz = (int)MathF.Floor(self.Position.Z / CellSize);
        const float radius = 4f;

        for (var ox = -1; ox <= 1; ox++)
            for (var oz = -1; oz <= 1; oz++)
            {
                if (!_grid.TryGetValue((cx + ox, cz + oz), out var cell)) continue;
                foreach (var other in cell)
                {
                    if (other == self || other.Team != self.Team) continue;
                    var d = self.Position.DistanceXZ(other.Position);
                    if (d < radius && d > 1e-4f)
                    {
                        // Linear falloff: strongest when nearly overlapping.
                        var push = (self.Position - other.Position).Normalized() * ((radius - d) / radius) * 20f;
                        result += new Vec3(push.X, 0f, push.Z);
                    }
                }
            }

        return result;
    }

    private void RebuildGrid()
    {
        _grid ??= new Dictionary<(int, int), List<Unit>>();
        _grid.Clear();
        foreach (var u in _units)
        {
            if (!u.Alive) continue;
            var key = ((int)MathF.Floor(u.Position.X / CellSize), (int)MathF.Floor(u.Position.Z / CellSize));
            if (!_grid.TryGetValue(key, out var list))
                _grid[key] = list = new List<Unit>();
            list.Add(u);
        }
    }

    // ------------------------------------------------------------------
    // Snapshot access for the renderer. The view fills pre-allocated buffers
    // (no per-frame allocation -> no GC pressure in WASM).
    // ------------------------------------------------------------------

    /// <summary>Fill x/z/heading spans for one team. Returns count written.</summary>
    public int FillTeamSnapshot(Team team, Span<float> xs, Span<float> zs, Span<float> headings)
    {
        var n = 0;
        foreach (var u in _units)
        {
            if (!u.Alive || u.Team != team) continue;
            if (n >= xs.Length) break;
            xs[n] = u.Position.X;
            zs[n] = u.Position.Z;
            headings[n] = u.Heading;
            n++;
        }
        return n;
    }

    /// <summary>Snapshot of one team into caller-provided buffers (zero allocation).</summary>
    public void FillTeam(Team team, float[] xs, float[] zs, float[] headings, out int count)
        => count = FillTeamSnapshot(team, xs.AsSpan(), zs.AsSpan(), headings.AsSpan());

    /// <summary>Camera focus point: midpoint between the two armies' front lines.</summary>
    public Vec3 FocusPoint => new((_playerTarget.X + _enemyTarget.X) / 2f, 0f, (_playerTarget.Z + _enemyTarget.Z) / 2f);
}
