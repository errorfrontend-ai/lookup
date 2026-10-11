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

  /// A rule that fails when an image is decoded without a decode size: `cacheWidth`, or
  /// `cacheHeight` for an image wider than its box (design §4.5, §2.6).
  factory SourceRule.imagesSetDecodeSize() => SourceRule._(
    name: 'image without a decode size',
    reason:
        'every Image sets cacheWidth or cacheHeight, so a banner is decoded at the size shown '
        '(§2.6)',
    findIn: (file) => [
      for (final match in _imageConstructor.allMatches(file.code))
        if (!_decodeSize.hasMatch(_argumentsOf(file.code, match.end - 1)))
          'line ${file.lineNumberAt(match.start)}: ${match.group(0)!.trim()}',
      for (final match in _bareImageProvider.allMatches(file.code))
        'line ${file.lineNumberAt(match.start)}: ${match.group(0)!.trim()} (use Image with '
            'cacheWidth or cacheHeight)',
    ],
  );

  /// A rule that fails when an animation's duration does not come from the motion tokens (design
  /// §4.5, §3.18). Each `duration:`, `reverseDuration:`, `transitionDuration:` or
  /// `reverseTransitionDuration:` argument must read a motion token (`….motion.fast`), be
  /// `Duration.zero` (no motion), or name a value that the same file sets only from those.
  ///
  /// A bottom sheet or a snackbar animates with Material's own durations unless it is given an
  /// animation style, so every `showModalBottomSheet`, `showBottomSheet` and `showSnackBar` call
  /// must pass one (`sheetAnimationStyle:`, `snackBarAnimationStyle:`) that reads a motion token,
  /// is `AnimationStyle.noAnimation`, or names a value the same file sets only from those. A style
  /// that can be `null` falls back to Material's durations, so it fails too (S4-ACCESSIBILITY-04).
  factory SourceRule.animationDurationsFromMotionTokens({RegExp? onlyPathsMatching}) =>
      SourceRule._(
        name: 'animation duration not from the motion tokens',
        reason:
            'every animation lasts motion.fast, motion.base or motion.slow, or nothing when the '
            'phone asks for less motion; a sheet or snackbar is given its animation style '
            '(§3.18, §4.5)',
        onlyPathsMatching: onlyPathsMatching,
        findIn: (file) => [
          for (final match in _durationArgument.allMatches(file.code))
            if (!_isFromMotionTokens(
              file.code,
              _expressionAt(file.code, match.end),
              _readsOnlyMotionTokens,
            ))
              'line ${file.lineNumberAt(match.start)}: ${match.group(0)!.trim()} '
                  '${_expressionAt(file.code, match.end).trim()}',
          for (final match in _animationStyleCall.allMatches(file.code))
            if (_animationStyleProblem(file.code, match) case final problem?)
              'line ${file.lineNumberAt(match.start)}: ${match.group(1)} $problem',
        ],
      );

  /// A rule that fails when words the listener sees are written in code instead of the ARB files
  /// (design §3.17, §4.5; P6-LOCALISATION-01): a string literal with a letter outside its
  /// interpolations, passed to `Text(` or `TextSpan(text:`, or as a label, a tooltip, a screen
  /// reader's label or a field's hint. A literal that only interpolates (`'$number'`) carries no
  /// words of its own and passes; [allowedLiterals] lists, by path, literals that are never shown.
  factory SourceRule.wordsOutsideLanguageFiles({
    required RegExp onlyPathsMatching,
    Map<String, Set<String>> allowedLiterals = const {},
  }) => SourceRule._(
    name: 'words written outside the ARB files',
    reason:
        'every word on a screen comes from lib/l10n/app_en.arb through AppLocalizations, so a '
        'language is added with one ARB file (§3.17, P6-LOCALISATION-01)',
    onlyPathsMatching: onlyPathsMatching,
    findIn: (file) {
      final literalsByOffset = {for (final literal in file.stringLiterals) literal.offset: literal};
      return [
        for (final match in _shownWordsPosition.allMatches(file.code))
          if (_literalStartingAt(file.code, match.end, literalsByOffset) case final literal?)
            if (_hasOwnWords(literal.value) &&
                !(allowedLiterals[file.path]?.contains(literal.value) ?? false))
              'line ${literal.lineNumber}: \'${literal.value}\'',
      ];
    },
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

  /// Where a widget takes words to show: `Text(` and `TextSpan(text:` with the words first, and the
  /// named arguments that become a label, a tooltip or a hint.
  static final RegExp _shownWordsPosition = RegExp(
    r'(?<![\w$.])(?:Text\s*\(|TextSpan\s*\(\s*text\s*:|'
    r'(?:label|semanticsLabel|semanticLabel|tooltip|message|hintText|labelText|helperText|'
    r'errorText|counterText)\s*:(?!:))\s*(?:const\s+)?',
  );

  /// Escapes (`\n`, `\u2026`), `${…}` and `$name` interpolations: none of them is a word.
  static final RegExp _escapesAndInterpolations = RegExp(
    r'\\u\{[0-9A-Fa-f]+\}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|\\.|\$\{[^}]*\}|\$[A-Za-z_]\w*',
  );
  static final RegExp _letter = RegExp(r'\p{L}', unicode: true);

  /// The literal whose opening quote is at [position] in [code] (an `r` prefix and a triple quote
  /// included), or null when the argument there is not a string literal.
  static DartStringLiteral? _literalStartingAt(
    String code,
    int position,
    Map<int, DartStringLiteral> literalsByOffset,
  ) {
    var index = position;
    if (index < code.length && code[index] == 'r') index++;
    if (index >= code.length || (code[index] != "'" && code[index] != '"')) return null;
    final quote = code[index];
    final delimiterLength = code.startsWith(quote * 3, index) ? 3 : 1;
    return literalsByOffset[index + delimiterLength];
  }

  /// Whether [value] has a letter of its own, outside its escapes and interpolations.
  static bool _hasOwnWords(String value) =>
      _letter.hasMatch(value.replaceAll(_escapesAndInterpolations, ''));

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
  static final RegExp _decodeSize = RegExp(r'\bcache(?:Width|Height)\b');
  static final RegExp _durationArgument = RegExp(
    r'(?<![\w$.])(?:duration|reverseDuration|transitionDuration|reverseTransitionDuration)\s*:'
    r'(?!:)',
  );
  static final RegExp _motionToken = RegExp(r'\bmotion\.\w+');
  static final RegExp _plainName = RegExp(r'^[A-Za-z_$][\w$]*$');
  static final RegExp _nullLiteral = RegExp(r'(?<![\w$.])null(?![\w$])');

  /// A call that shows a sheet or a snackbar, which animates with Material's own durations unless
  /// it is given an animation style; [_animationStyleParameters] names the argument that sets it.
  static final RegExp _animationStyleCall = RegExp(
    r'(?<![\w$])(showModalBottomSheet|showBottomSheet|showSnackBar)\s*(?:<[^<>()]*>)?\s*\(',
  );
  static const Map<String, String> _animationStyleParameters = {
    'showModalBottomSheet': 'sheetAnimationStyle',
    'showBottomSheet': 'sheetAnimationStyle',
    'showSnackBar': 'snackBarAnimationStyle',
  };

  /// What is wrong with the animation style of the call [match] found in [code], or null when the
  /// style comes from the motion tokens.
  static String? _animationStyleProblem(String code, RegExpMatch match) {
    final parameter = _animationStyleParameters[match.group(1)]!;
    final openingIndex = match.end - 1;
    final argument = RegExp(
      '(?<![\\w\$.])$parameter\\s*:(?!:)',
    ).firstMatch(_argumentsOf(code, openingIndex));
    if (argument == null) return 'without $parameter (Material\'s own durations)';
    final expression = _expressionAt(code, openingIndex + argument.end);
    return _isFromMotionTokens(code, expression, _readsOnlyMotionStyle)
        ? null
        : '$parameter: ${expression.trim()}';
  }

  /// Whether [expression], an animation's duration or style in [code], comes from the motion
  /// tokens: it is no motion at all, [readsOnlyMotion] accepts it, or it names a value that [code]
  /// sets only from what [readsOnlyMotion] accepts.
  static bool _isFromMotionTokens(
    String code,
    String expression,
    bool Function(String text) readsOnlyMotion,
  ) {
    final text = expression.trim();
    if (text == 'Duration.zero' || text == 'AnimationStyle.noAnimation') return true;
    if (_plainName.hasMatch(text)) {
      final settings = RegExp(
        '(?<![\\w\$.])${RegExp.escape(text)}\\s*=(?![=>])([^;]*);',
      ).allMatches(code).toList();
      return settings.isNotEmpty && settings.every((setting) => readsOnlyMotion(setting.group(1)!));
    }
    return readsOnlyMotion(text);
  }

  /// A motion token, possibly beside `Duration.zero`, and no duration written out.
  static bool _readsOnlyMotionTokens(String text) =>
      _motionToken.hasMatch(text) && !text.contains('Duration(');

  /// Motion tokens, possibly beside `AnimationStyle.noAnimation`, and never `null`, which means
  /// Material's own durations.
  static bool _readsOnlyMotionStyle(String text) =>
      _readsOnlyMotionTokens(text) && !_nullLiteral.hasMatch(text);

  /// The expression that starts at [start] in [code]: up to the comma, bracket or semicolon that
  /// ends it at its own nesting level.
  static String _expressionAt(String code, int start) {
    var depth = 0;
    for (var index = start; index < code.length; index++) {
      final character = code[index];
      if ('([{'.contains(character)) depth++;
      if (')]}'.contains(character)) {
        if (depth == 0) return code.substring(start, index);
        depth--;
      }
      if ((character == ',' || character == ';') && depth == 0) {
        return code.substring(start, index);
      }
    }
    return code.substring(start);
  }

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
