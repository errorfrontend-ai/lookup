/// A pub version constraint such as `^3.11.5`, `">=3.41.0"` or `">=3.11.5 <4.0.0"`, enough to ask
/// whether it admits the Flutter and Dart installed on the build machine (design §3.3, S4-STACK-01).
final class VersionConstraint {
  VersionConstraint._(this.text, this._bounds);

  /// Reads [text]: `any`, an exact version, `^version`, or bounds with `>=`, `>`, `<=`, `<`
  /// separated by spaces. Throws a [FormatException] for anything else.
  factory VersionConstraint.parse(String text) {
    final trimmed = text.trim();
    if (trimmed == 'any') return VersionConstraint._(text, const []);
    final bounds = <_VersionBound>[];
    for (final part in trimmed.split(RegExp(r'\s+'))) {
      if (part.startsWith('^')) {
        final lowest = SemanticVersion.parse(part.substring(1));
        bounds
          ..add(_VersionBound('>=', lowest))
          ..add(_VersionBound('<', lowest.nextBreakingVersion));
        continue;
      }
      final match = RegExp(r'^(>=|<=|>|<)?(.+)$').firstMatch(part);
      if (match == null) throw FormatException('Not a version constraint: $text');
      bounds.add(_VersionBound(match.group(1) ?? '==', SemanticVersion.parse(match.group(2)!)));
    }
    return VersionConstraint._(text, bounds);
  }

  final String text;
  final List<_VersionBound> _bounds;

  /// Whether [version] satisfies every bound.
  bool allows(SemanticVersion version) => _bounds.every((bound) => bound.allows(version));

  @override
  String toString() => text;
}

/// A version `major.minor.patch`, with an optional `-pre-release` and `+build` (build ignored).
final class SemanticVersion implements Comparable<SemanticVersion> {
  const SemanticVersion(this.major, this.minor, this.patch, [this.preRelease = '']);

  factory SemanticVersion.parse(String text) {
    final match = RegExp(
      r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$',
    ).firstMatch(text.trim());
    if (match == null) throw FormatException('Not a version: $text');
    return SemanticVersion(
      int.parse(match.group(1)!),
      int.parse(match.group(2)!),
      int.parse(match.group(3)!),
      match.group(4) ?? '',
    );
  }

  final int major;
  final int minor;
  final int patch;
  final String preRelease;

  /// The first version `^this` no longer admits: the next major, or the next minor below 1.0.0.
  SemanticVersion get nextBreakingVersion =>
      major > 0 ? SemanticVersion(major + 1, 0, 0) : SemanticVersion(0, minor + 1, 0);

  @override
  int compareTo(SemanticVersion other) {
    for (final difference in [major - other.major, minor - other.minor, patch - other.patch]) {
      if (difference != 0) return difference;
    }
    if (preRelease == other.preRelease) return 0;
    if (preRelease.isEmpty) return 1;
    if (other.preRelease.isEmpty) return -1;
    return preRelease.compareTo(other.preRelease);
  }

  @override
  String toString() => '$major.$minor.$patch${preRelease.isEmpty ? '' : '-$preRelease'}';
}

final class _VersionBound {
  const _VersionBound(this.operator, this.version);

  final String operator;
  final SemanticVersion version;

  bool allows(SemanticVersion candidate) {
    final comparison = candidate.compareTo(version);
    return switch (operator) {
      '>=' => comparison >= 0,
      '>' => comparison > 0,
      '<=' => comparison <= 0,
      '<' => comparison < 0,
      _ => comparison == 0,
    };
  }
}
