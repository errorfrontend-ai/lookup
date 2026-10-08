/// Reads the small part of YAML that `pubspec.yaml` and `pubspec.lock` use: maps nested by
/// indentation, `- item` lists, plain or quoted scalars, and comments. Every scalar is read as a
/// string. The app may not add `package:yaml` as a dependency (design §3.3), and this is enough to
/// check its pins (§4.5).
abstract final class SimpleYamlReader {
  /// The document's top-level map. Throws a [FormatException] for anything outside that subset, so
  /// a pubspec this reader misunderstands fails the test rather than passing it.
  static Map<String, Object?> read(String text) {
    final lines = <_YamlLine>[];
    for (final rawLine in text.split('\n')) {
      final line = _withoutComment(rawLine.replaceAll('\r', ''));
      if (line.trim().isEmpty) continue;
      lines.add(_YamlLine(line.length - line.trimLeft().length, line.trim()));
    }
    if (lines.isEmpty) return {};
    final cursor = _YamlCursor(lines);
    final map = _readMap(cursor, lines.first.indent);
    if (cursor.index < lines.length) {
      throw FormatException('Unexpected indentation: ${lines[cursor.index].content}');
    }
    return map;
  }

  static Object? _readNode(_YamlCursor cursor, int indent) {
    final first = cursor.lines[cursor.index];
    return _isListItem(first.content) ? _readList(cursor, indent) : _readMap(cursor, indent);
  }

  static Map<String, Object?> _readMap(_YamlCursor cursor, int indent) {
    final map = <String, Object?>{};
    while (cursor.index < cursor.lines.length) {
      final line = cursor.lines[cursor.index];
      if (line.indent < indent) break;
      if (line.indent > indent || _isListItem(line.content)) {
        throw FormatException('Unexpected line in a map: ${line.content}');
      }
      final colon = _mappingColon(line.content);
      if (colon < 0) throw FormatException('Not a "key: value" line: ${line.content}');
      final key = _scalar(line.content.substring(0, colon).trim());
      final value = line.content.substring(colon + 1).trim();
      cursor.index++;
      if (value.isNotEmpty) {
        map[key] = _scalar(value);
      } else if (cursor.index < cursor.lines.length &&
          (cursor.lines[cursor.index].indent > indent ||
              (cursor.lines[cursor.index].indent == indent &&
                  _isListItem(cursor.lines[cursor.index].content)))) {
        map[key] = _readNode(cursor, cursor.lines[cursor.index].indent);
      } else {
        map[key] = null;
      }
    }
    return map;
  }

  static List<Object?> _readList(_YamlCursor cursor, int indent) {
    final list = <Object?>[];
    while (cursor.index < cursor.lines.length) {
      final line = cursor.lines[cursor.index];
      if (line.indent != indent || !_isListItem(line.content)) break;
      final item = line.content.substring(1).trim();
      if (_mappingColon(item) >= 0) {
        // `- key: value` starts a map whose keys sit two columns in.
        cursor.lines[cursor.index] = _YamlLine(indent + 2, item);
        list.add(_readMap(cursor, indent + 2));
      } else {
        cursor.index++;
        list.add(item.isEmpty ? null : _scalar(item));
      }
    }
    return list;
  }

  static bool _isListItem(String content) => content == '-' || content.startsWith('- ');

  /// The offset of the colon that ends a key: the first `:` outside quotes followed by a space or
  /// the end of the line.
  static int _mappingColon(String content) {
    String? quote;
    for (var index = 0; index < content.length; index++) {
      final character = content[index];
      if (quote != null) {
        if (character == quote) quote = null;
      } else if (character == '"' || character == "'") {
        quote = character;
      } else if (character == ':' && (index + 1 == content.length || content[index + 1] == ' ')) {
        return index;
      }
    }
    return -1;
  }

  static String _scalar(String text) {
    final isQuoted =
        text.length >= 2 &&
        ((text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'")));
    return isQuoted ? text.substring(1, text.length - 1) : text;
  }

  static String _withoutComment(String line) {
    String? quote;
    for (var index = 0; index < line.length; index++) {
      final character = line[index];
      if (quote != null) {
        if (character == quote) quote = null;
      } else if (character == '"' || character == "'") {
        quote = character;
      } else if (character == '#' && (index == 0 || line[index - 1] == ' ')) {
        return line.substring(0, index);
      }
    }
    return line;
  }
}

final class _YamlLine {
  const _YamlLine(this.indent, this.content);

  final int indent;
  final String content;
}

final class _YamlCursor {
  _YamlCursor(this.lines);

  final List<_YamlLine> lines;
  int index = 0;
}
