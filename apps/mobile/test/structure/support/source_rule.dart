import 'dart_source_file.dart';
import 'dart_source_tree.dart';
import 'naming_rules.dart';

/// One rule of the source scans (design §4.5): what it forbids, why, and how to find it in a file.
final class SourceRule {
  const SourceRule._({
    required this.name,
    required this.reason,
    required List<String> Function(DartSourceFile file) findIn,
    this.exemptPaths = const {},
    this.onlyPathsMatching,
  }) : _findIn = findIn;

  /// A rule that fails when [pattern] matches code (comments and string contents left out), in
  /// every file or only in those whose path matches [onlyPathsMatching].
  factory SourceRule.codePattern(
    String name, {
    required RegExp pattern,
    required String reason,
    Set<String> exemptPaths = const {},
    RegExp? onlyPathsMatching,
  }) => SourceRule._(
    name: name,
    reason: reason,
    exemptPaths: exemptPaths,
    onlyPathsMatching: onlyPathsMatching,
    findIn: (file) => [
      for (final match in pattern.allMatches(file.code))
        'line ${file.lineNumberAt(match.start)}: ${match.group(0)!.trim()}',
    ],
  );

  /// A rule that fails when [pattern] matches inside a string literal, except the literals
  /// [allowedLiterals] lists for a file by its path.
  factory SourceRule.stringPattern(
    String name, {
    required RegExp pattern,
    required String reason,
    Map<String, Set<String>> allowedLiterals = const {},
  }) => SourceRule._(
    name: name,
    reason: reason,
    findIn: (file) => [
      for (final literal in file.stringLiterals)
        if (pattern.hasMatch(literal.value) &&
            !(allowedLiterals[file.path]?.contains(literal.value) ?? false))
          'line ${literal.lineNumber}: \'${literal.value}\'',
    ],
  );

  /// A rule that fails when a name in the code holds one of the banned short words (S4-NAMING-01).
  factory SourceRule.bannedShortWordsInNames() => SourceRule._(
    name: 'abbreviated name',
    reason: 'names are whole words: no ${NamingRules.bannedShortWords.join(', ')} (S4-NAMING-01)',
    findIn: (file) => _onePerName(file, NamingRules.bannedShortWordsIn),
  );

  /// A rule that fails when a name or a string uses a banned domain word (S4-NAMING-05).
  factory SourceRule.bannedDomainWords() => SourceRule._(
    name: 'banned domain word',
    reason:
        'the project says station, client, ad, action card, campaign, never tenant, '
        'customer, spot or payload (S4-NAMING-05)',
    findIn: (file) => [
      ..._onePerName(file, NamingRules.bannedDomainWordsIn),
      for (final literal in file.stringLiterals)
        if (_bannedDomainWordInText.hasMatch(literal.value))
          'line ${literal.lineNumber}: \'${literal.value}\'',
    ],
  );

  /// A rule that fails when an image is decoded without `cacheWidth` (design §4.5, §2.6).
  factory SourceRule.imagesSetCacheWidth() => SourceRule._(
    name: 'image without cacheWidth',
    reason: 'every Image sets cacheWidth, so a banner is decoded at the size shown (§2.6)',
    findIn: (file) => [
      for (final match in _imageConstructor.allMatches(file.code))
        if (!_argumentsOf(file.code, match.end - 1).contains('cacheWidth'))
          'line ${file.lineNumberAt(match.start)}: ${match.group(0)!.trim()}',
      for (final match in _bareImageProvider.allMatches(file.code))
        'line ${file.lineNumberAt(match.start)}: ${match.group(0)!.trim()} (use Image with '
            'cacheWidth)',
    ],
  );

  /// A short name for the rule, used in test names.
  final String name;

  /// Why the rule exists, with its design section.
  final String reason;

  /// Paths (relative to the scanned folder) the rule does not apply to.
  final Set<String> exemptPaths;

  /// When set, the rule applies only to paths this matches.
  final RegExp? onlyPathsMatching;

  final List<String> Function(DartSourceFile file) _findIn;

  /// Applies the rule to every file of [tree] it covers.
  SourceRuleResult findViolationsIn(DartSourceTree tree) {
    var fileCount = 0;
    final violations = <String>[];
    for (final file in tree.files) {
      if (exemptPaths.contains(file.path)) continue;
      if (!(onlyPathsMatching?.hasMatch(file.path) ?? true)) continue;
      fileCount++;
      for (final finding in _findIn(file)) {
        violations.add('${file.path} $finding');
      }
    }
    return SourceRuleResult(fileCount, violations);
  }

  static final RegExp _bannedDomainWordInText = RegExp(
    r'\b(?:tenants?|customers?|spots?|payloads?)\b',
    caseSensitive: false,
  );
  static final RegExp _imageConstructor = RegExp(
    r'(?<![\w$.])Image(?:\.(?:network|memory|asset|file))?\s*\(',
  );
  static final RegExp _bareImageProvider = RegExp(
    r'(?<![\w$.])(?:NetworkImage|MemoryImage|FileImage)\s*\(',
  );

  static List<String> _onePerName(DartSourceFile file, List<String> Function(String) wordsIn) {
    final reportedNames = <String>{};
    return [
      for (final identifier in file.identifiers)
        if (wordsIn(identifier.name).isNotEmpty && reportedNames.add(identifier.name))
          'line ${identifier.lineNumber}: ${identifier.name} '
              '(${wordsIn(identifier.name).join(', ')})',
    ];
  }

  /// The text between the parenthesis at [openingIndex] and the one that closes it.
  static String _argumentsOf(String code, int openingIndex) {
    var depth = 0;
    for (var index = openingIndex; index < code.length; index++) {
      if (code[index] == '(') depth++;
      if (code[index] == ')') {
        depth--;
        if (depth == 0) return code.substring(openingIndex, index);
      }
    }
    return code.substring(openingIndex);
  }
}

/// What one rule found: how many files it read and what it found in them.
final class SourceRuleResult {
  const SourceRuleResult(this.fileCount, this.violations);

  final int fileCount;
  final List<String> violations;
}
