namespace Game.Core;

public enum Team : int
{
    Player = 0,
    Enemy = 1,
}

/// <summary>
/// A single ground unit. The sim owns all state; the view only reads it.
/// </summary>
public sealed class Unit
{
    public int Id { get; init; }
    public Team Team { get; init; }
    public Vec3 Position { get; set; }

    /// <summary>Yaw in radians (around +Y). Used by the renderer to orient models.</summary>
    public float Heading { get; set; }

    /// <summary>Cruise speed (world units / second), with per-unit jitter so ranks don't lockstep.</summary>
    public float MaxSpeed { get; init; }

    /// <summary>Per-unit phase for lateral wobble, keeps formations from looking rigid.</summary>
    public float WobblePhase { get; init; }

    public bool Alive { get; set; } = true;
}
