namespace Game.Core;

/// <summary>
/// Minimal 3D vector for the sim. Deliberately not System.Numerics so the
/// core stays dependency-free and trivially serializable across interop.
/// </summary>
public readonly struct Vec3 : IEquatable<Vec3>
{
    public readonly float X;
    public readonly float Y;
    public readonly float Z;

    public Vec3(float x, float y, float z) { X = x; Y = y; Z = z; }

    public static Vec3 Zero => new(0f, 0f, 0f);
    public static Vec3 Up   => new(0f, 1f, 0f);

    public float Length() => MathF.Sqrt(X * X + Y * Y + Z * Z);

    public Vec3 Normalized()
    {
        var l = Length();
        return l < 1e-6f ? Zero : new Vec3(X / l, Y / l, Z / l);
    }

    public bool Equals(Vec3 other) => X == other.X && Y == other.Y && Z == other.Z;
    public override bool Equals(object? obj) => obj is Vec3 v && Equals(v);
    public override int GetHashCode() => HashCode.Combine(X, Y, Z);
    public static bool operator ==(Vec3 a, Vec3 b) => a.Equals(b);
    public static bool operator !=(Vec3 a, Vec3 b) => !a.Equals(b);

    public static Vec3 operator +(Vec3 a, Vec3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
    public static Vec3 operator -(Vec3 a, Vec3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
    public static Vec3 operator *(Vec3 a, float s) => new(a.X * s, a.Y * s, a.Z * s);

    /// <summary>Distance on the ground plane (Y ignored).</summary>
    public float DistanceXZ(Vec3 other)
    {
        var dx = X - other.X;
        var dz = Z - other.Z;
        return MathF.Sqrt(dx * dx + dz * dz);
    }

    public override string ToString() => $"({X:F1}, {Y:F1}, {Z:F1})";
}
