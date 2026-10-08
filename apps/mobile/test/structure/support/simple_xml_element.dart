/// An element of a small XML file such as an Android manifest or a network-security configuration,
/// read without a package (the app may not add `package:xml`; design §3.3). Comments, processing
/// instructions and the doctype are dropped; attributes must use double quotes, as Android's do.
final class SimpleXmlElement {
  SimpleXmlElement(this.name, this.attributes);

  /// Reads [xml] and returns its root element. Throws a [FormatException] when tags do not nest.
  factory SimpleXmlElement.parse(String xml) {
    final cleaned = xml
        .replaceAll(RegExp(r'<!--[\s\S]*?-->'), '')
        .replaceAll(RegExp(r'<\?[\s\S]*?\?>'), '')
        .replaceAll(RegExp(r'<!DOCTYPE[^>]*>'), '');
    final document = SimpleXmlElement('#document', const {});
    final open = <SimpleXmlElement>[document];
    var textStart = 0;
    for (final tag in _tagPattern.allMatches(cleaned)) {
      open.last._text.write(cleaned.substring(textStart, tag.start));
      textStart = tag.end;
      final isClosing = tag.group(1) == '/';
      final name = tag.group(2)!;
      if (isClosing) {
        if (open.length < 2 || open.last.name != name) {
          throw FormatException('Unexpected </$name>');
        }
        open.removeLast();
        continue;
      }
      final element = SimpleXmlElement(name, {
        for (final attribute in _attributePattern.allMatches(tag.group(3)!))
          attribute.group(1)!: attribute.group(2)!,
      });
      open.last.children.add(element);
      if (tag.group(4) != '/') open.add(element);
    }
    if (open.length != 1 || document.children.length != 1) {
      throw const FormatException('The XML does not have exactly one closed root element');
    }
    return document.children.single;
  }

  /// The tag name, e.g. `uses-permission`.
  final String name;

  /// The attributes by their full name, e.g. `android:name`.
  final Map<String, String> attributes;

  /// The child elements, in order.
  final List<SimpleXmlElement> children = [];

  final StringBuffer _text = StringBuffer();

  /// The text directly inside this element, trimmed.
  String get text => _text.toString().trim();

  /// The direct children named [childName].
  Iterable<SimpleXmlElement> childrenNamed(String childName) =>
      children.where((child) => child.name == childName);

  /// Every element below this one named [descendantName], at any depth.
  Iterable<SimpleXmlElement> descendantsNamed(String descendantName) sync* {
    for (final child in children) {
      if (child.name == descendantName) yield child;
      yield* child.descendantsNamed(descendantName);
    }
  }

  static final RegExp _tagPattern = RegExp(
    r'<(/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(/?)>',
  );
  static final RegExp _attributePattern = RegExp(r'([\w:.-]+)\s*=\s*"([^"]*)"');
}
