/// One Dart file read as text for the structure scans (design §4.5), with its code, its comments and
/// its string literals told apart, so a rule about code never fires on a comment and a rule about
/// addresses looks only inside strings.
///
/// The reader is a small lexer, not the analyzer: the app may not add `package:analyzer` as a
/// dependency, and the scans only need to know which characters are code.
final class DartSourceFile {
  DartSourceFile._(this.path, this.text, this.code, this.textWithoutComments, this.stringLiterals);

  /// Reads [text], the contents of the file at [path] (a `/`-separated path such as
  /// `features/identify/data/clip_recorder.dart`).
  factory DartSourceFile.parse(String path, String text) {
    final lexer = _DartLexer(text)..read();
    return DartSourceFile._(
      path,
      text,
      String.fromCharCodes(lexer.code),
      String.fromCharCodes(lexer.textWithoutComments),
      List.unmodifiable(lexer.stringLiterals),
    );
  }

  /// The file's path from the folder that was scanned, separated by `/`.
  final String path;

  /// The file as written.
  final String text;

  /// The file with every comment and every string literal's contents replaced by spaces (line
  /// breaks kept, so offsets and line numbers stay the same). Interpolated expressions stay code.
  final String code;

  /// The file with comments replaced by spaces and strings kept.
  final String textWithoutComments;

  /// Every string literal, with its contents as written (escapes and interpolations unexpanded).
  final List<DartStringLiteral> stringLiterals;

  /// The file's name, e.g. `clip_recorder.dart`.
  String get fileName => path.split('/').last;

  /// The line, counted from 1, that holds [offset].
  int lineNumberAt(int offset) => '\n'.allMatches(text.substring(0, offset)).length + 1;

  /// The `import`, `export` and `part` directives, in order.
  late final List<DartDirective> directives = _readDirectives();

  /// The classes, enums, mixins, extensions and typedefs declared at the top level.
  late final List<DartTypeDeclaration> typeDeclarations = [
    for (final match in _typeDeclarationPattern.allMatches(code))
      if (!_unnamedDeclarationWords.contains(match.group(2)))
        DartTypeDeclaration(match.group(2)!, lineNumberAt(match.start)),
  ];

  /// Every name declared at the top level: types, variables, functions and getters.
  late final Set<String> topLevelNames = {
    for (final declaration in typeDeclarations) declaration.name,
    for (final pattern in _topLevelNamePatterns)
      for (final match in pattern.allMatches(code))
        if (match.group(1) != null && !_reservedWords.contains(match.group(1))) match.group(1)!,
  };

  /// Every identifier in the code (comments and string contents left out), with its line.
  late final List<DartIdentifier> identifiers = [
    for (final match in _identifierPattern.allMatches(code))
      DartIdentifier(match.group(0)!, lineNumberAt(match.start)),
  ];

  late final Set<String> _identifierNames = {for (final identifier in identifiers) identifier.name};

  /// Whether [name] appears in the code as a whole identifier.
  bool usesIdentifier(String name) => _identifierNames.contains(name);

  List<DartDirective> _readDirectives() {
    final directives = <DartDirective>[];
    for (final match in _directiveStartPattern.allMatches(code)) {
      final end = code.indexOf(';', match.start);
      if (end < 0) continue;
      final directiveText = textWithoutComments.substring(match.start, end);
      final uri = _quotedUriPattern.firstMatch(directiveText)?.group(1);
      if (uri == null) continue;
      final combinators = directiveText.substring(directiveText.indexOf(uri) + uri.length + 1);
      final shownNames = <String>{};
      for (final show in _showCombinatorPattern.allMatches(combinators)) {
        shownNames.addAll(
          show.group(1)!.split(',').map((name) => name.trim()).where((name) => name.isNotEmpty),
        );
      }
      directives.add(
        DartDirective(
          keyword: match.group(1)!,
          uri: uri,
          shownNames: shownNames,
          lineNumber: lineNumberAt(match.start),
        ),
      );
    }
    return directives;
  }

  static final RegExp _directiveStartPattern = RegExp(
    r'^(import|export|part)\b(?!\s+of\b)',
    multiLine: true,
  );
  static final RegExp _quotedUriPattern = RegExp(r'''['"]([^'"]*)['"]''');
  static final RegExp _showCombinatorPattern = RegExp(r'\bshow\b([\s\S]*?)(?=\bhide\b|$)');
  static final RegExp _typeDeclarationPattern = RegExp(
    r'^(?:(?:abstract|sealed|final|base|interface|mixin)\s+)*'
    r'(class|enum|mixin|typedef|extension\s+type|extension)\s+([A-Za-z_$][\w$]*)',
    multiLine: true,
  );
  static const Set<String> _unnamedDeclarationWords = {'on', 'const'};
  static final List<RegExp> _topLevelNamePatterns = [
    // final Provider<ActionLauncher> actionLauncherProvider = …;   const String prefix = …;
    RegExp(
      r'^(?:late\s+)?(?:final|const|var)\s[^;=(){}]*?(?<![\w$])([A-Za-z_$][\w$]*)\s*=(?!=)',
      multiLine: true,
    ),
    // String? buildActionUri(UiAction action) {   Future<void> main() async {
    RegExp(
      r'^(?!(?:import|export|part|library|class|enum|mixin|typedef|extension|abstract|sealed|final'
      r'|base|interface|const|var|late)\b)[A-Za-z_$][\w$<>?,\[\] ]*?[ ]([A-Za-z_$][\w$]*)[ ]*'
      r'(?:<[^()\n]*>)?\(',
      multiLine: true,
    ),
    // String get currentRoute => …;
    RegExp(r'^[A-Za-z_$][\w$<>?,\[\] ]*?[ ]get[ ]+([A-Za-z_$][\w$]*)', multiLine: true),
  ];
  static const Set<String> _reservedWords = {'get', 'set', 'operator', 'if', 'for', 'while'};
  static final RegExp _identifierPattern = RegExp(r'(?<![\w$])[A-Za-z_$][\w$]*');
}

/// A string literal's contents as written, and where they start.
final class DartStringLiteral {
  const DartStringLiteral(this.value, this.offset, this.lineNumber);

  final String value;
  final int offset;
  final int lineNumber;
}

/// An `import`, `export` or `part` directive.
final class DartDirective {
  const DartDirective({
    required this.keyword,
    required this.uri,
    required this.shownNames,
    required this.lineNumber,
  });

  final String keyword;
  final String uri;

  /// The names after `show`, empty when the directive has no `show`.
  final Set<String> shownNames;
  final int lineNumber;
}

/// A top-level class, enum, mixin, extension or typedef.
final class DartTypeDeclaration {
  const DartTypeDeclaration(this.name, this.lineNumber);

  final String name;
  final int lineNumber;

  bool get isPublic => !name.startsWith('_');
}

/// An identifier in code and its line.
final class DartIdentifier {
  const DartIdentifier(this.name, this.lineNumber);

  final String name;
  final int lineNumber;
}

/// Walks the text once, blanking comments (in both outputs) and string contents (in [code] only).
final class _DartLexer {
  _DartLexer(this.text)
    : code = text.codeUnits.toList(),
      textWithoutComments = text.codeUnits.toList();

  final String text;
  final List<int> code;
  final List<int> textWithoutComments;
  final List<DartStringLiteral> stringLiterals = [];

  static const int _space = 0x20;
  static const int _lineFeed = 0x0A;
  static const int _carriageReturn = 0x0D;

  void read() => _readCode(0, stopsAtClosingBrace: false);

  /// Reads code from [start]; when [stopsAtClosingBrace], stops at the `}` that closes an
  /// interpolation and returns its offset.
  int _readCode(int start, {required bool stopsAtClosingBrace}) {
    var index = start;
    var braceDepth = 0;
    while (index < text.length) {
      final character = text[index];
      final next = index + 1 < text.length ? text[index + 1] : '';
      if (character == '/' && next == '/') {
        index = _readLineComment(index);
      } else if (character == '/' && next == '*') {
        index = _readBlockComment(index);
      } else if (character == "'" || character == '"') {
        index = _readString(index, isRaw: false);
      } else if (character == 'r' &&
          (next == "'" || next == '"') &&
          !_isIdentifierCharacterAt(index - 1)) {
        index = _readString(index + 1, isRaw: true);
      } else {
        if (character == '{') braceDepth++;
        if (character == '}') {
          if (stopsAtClosingBrace && braceDepth == 0) return index;
          braceDepth--;
        }
        index++;
      }
    }
    return index;
  }

  int _readLineComment(int start) {
    var index = start;
    while (index < text.length && text.codeUnitAt(index) != _lineFeed) {
      _blankComment(index);
      index++;
    }
    return index;
  }

  int _readBlockComment(int start) {
    var index = start;
    var depth = 0;
    do {
      if (text.startsWith('/*', index)) {
        depth++;
        _blankComment(index);
        _blankComment(index + 1);
        index += 2;
      } else if (text.startsWith('*/', index)) {
        depth--;
        _blankComment(index);
        _blankComment(index + 1);
        index += 2;
      } else {
        _blankComment(index);
        index++;
      }
    } while (depth > 0 && index < text.length);
    return index;
  }

  int _readString(int quoteIndex, {required bool isRaw}) {
    final quote = text[quoteIndex];
    final delimiter = text.startsWith(quote * 3, quoteIndex) ? quote * 3 : quote;
    final isMultiline = delimiter.length == 3;
    final contentStart = quoteIndex + delimiter.length;
    final contents = StringBuffer();
    var index = contentStart;
    while (index < text.length) {
      if (text.startsWith(delimiter, index)) {
        _addLiteral(contents, contentStart);
        return index + delimiter.length;
      }
      final character = text[index];
      if (!isMultiline && text.codeUnitAt(index) == _lineFeed) break;
      if (!isRaw && character == r'\' && index + 1 < text.length) {
        contents.write(text.substring(index, index + 2));
        _blankCode(index);
        _blankCode(index + 1);
        index += 2;
      } else if (!isRaw && character == r'$' && index + 1 < text.length && text[index + 1] == '{') {
        _blankCode(index);
        _blankCode(index + 1);
        final end = _readCode(index + 2, stopsAtClosingBrace: true);
        contents.write(text.substring(index, end < text.length ? end + 1 : text.length));
        if (end < text.length) _blankCode(end);
        index = end + 1;
      } else if (!isRaw && character == r'$') {
        // `$name`: the name stays visible as code, because it is a use of that name.
        contents.write(character);
        _blankCode(index);
        index++;
        while (index < text.length && _isIdentifierCharacterAt(index) && text[index] != r'$') {
          contents.write(text[index]);
          index++;
        }
      } else {
        contents.write(character);
        _blankCode(index);
        index++;
      }
    }
    _addLiteral(contents, contentStart);
    return index;
  }

  void _addLiteral(StringBuffer contents, int contentStart) {
    final lineNumber = '\n'.allMatches(text.substring(0, contentStart)).length + 1;
    stringLiterals.add(DartStringLiteral(contents.toString(), contentStart, lineNumber));
  }

  bool _isIdentifierCharacterAt(int index) {
    if (index < 0 || index >= text.length) return false;
    final unit = text.codeUnitAt(index);
    return (unit >= 0x30 && unit <= 0x39) ||
        (unit >= 0x41 && unit <= 0x5A) ||
        (unit >= 0x61 && unit <= 0x7A) ||
        unit == 0x5F ||
        unit == 0x24;
  }

  void _blankComment(int index) {
    if (index >= text.length || _isLineBreak(index)) return;
    code[index] = _space;
    textWithoutComments[index] = _space;
  }

  void _blankCode(int index) {
    if (index >= text.length || _isLineBreak(index)) return;
    code[index] = _space;
  }

  bool _isLineBreak(int index) {
    final unit = text.codeUnitAt(index);
    return unit == _lineFeed || unit == _carriageReturn;
  }
}
