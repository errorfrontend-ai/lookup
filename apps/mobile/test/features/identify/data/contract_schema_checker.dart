/// Checks a flat object against one of the emitted JSON Schemas in `packages/contracts/schemas`,
/// without a schema package (design §4.1): `type: object`, `required`, `properties`,
/// `additionalProperties: false`, and per property `type: string`, `enum`, `const`, `pattern`,
/// `minLength` and `maxLength`. `format` is an annotation the checker relies on `pattern` for.
///
/// Any other keyword makes the check fail loudly instead of passing silently, so the checker can
/// never approve a body against a rule it does not understand.
abstract final class ContractSchemaChecker {
  /// Every way [value] breaks [schema]; empty when it passes. [schema] is the decoded schema file;
  /// a top-level `$ref` into its `$defs` is followed.
  static List<String> problemsWith(Object? value, Map<String, Object?> schema) {
    final definition = _resolve(schema, schema);
    final problems = <String>[];
    _checkKeywords(definition, _objectKeywords, 'the schema', problems);
    if (definition['type'] != 'object') problems.add('the schema is not for an object');
    if (value is! Map<String, Object?>) return [...problems, 'the value is not an object'];
    final properties = definition['properties'] as Map<String, Object?>? ?? const {};
    for (final name in (definition['required'] as List<Object?>? ?? const []).cast<String>()) {
      if (!value.containsKey(name)) problems.add('$name is required');
    }
    for (final MapEntry(key: name, value: fieldValue) in value.entries) {
      final property = properties[name];
      if (property == null) {
        if (definition['additionalProperties'] == false) problems.add('$name is not allowed');
        continue;
      }
      _checkProperty(name, fieldValue, property as Map<String, Object?>, problems);
    }
    return problems;
  }

  static void _checkProperty(
    String name,
    Object? value,
    Map<String, Object?> property,
    List<String> problems,
  ) {
    _checkKeywords(property, _propertyKeywords, name, problems);
    if (property.containsKey('format') && !property.containsKey('pattern')) {
      problems.add(
        '$name: the checker cannot check format ${property['format']} without a pattern',
      );
    }
    if (property['type'] != 'string') {
      problems.add('$name: the checker only knows text properties');
      return;
    }
    if (value is! String) {
      problems.add('$name is not text');
      return;
    }
    final allowedValues = property['enum'];
    if (allowedValues is List<Object?> && !allowedValues.contains(value)) {
      problems.add('$name: "$value" is not one of $allowedValues');
    }
    if (property.containsKey('const') && property['const'] != value) {
      problems.add('$name: "$value" is not ${property['const']}');
    }
    final pattern = property['pattern'];
    if (pattern is String && !RegExp(pattern).hasMatch(value)) {
      problems.add('$name: "$value" does not match its pattern');
    }
    final minimumLength = property['minLength'];
    if (minimumLength is int && value.length < minimumLength) {
      problems.add('$name is shorter than $minimumLength');
    }
    final maximumLength = property['maxLength'];
    if (maximumLength is int && value.length > maximumLength) {
      problems.add('$name is longer than $maximumLength');
    }
  }

  static Map<String, Object?> _resolve(Map<String, Object?> node, Map<String, Object?> schema) {
    final reference = node[r'$ref'];
    if (reference is! String) return node;
    const prefix = r'#/$defs/';
    if (!reference.startsWith(prefix)) throw StateError('Unsupported reference $reference');
    final definitions = schema[r'$defs'] as Map<String, Object?>;
    return definitions[reference.substring(prefix.length)] as Map<String, Object?>;
  }

  static void _checkKeywords(
    Map<String, Object?> node,
    Set<String> knownKeywords,
    String where,
    List<String> problems,
  ) {
    for (final keyword in node.keys) {
      if (!knownKeywords.contains(keyword)) {
        problems.add('$where uses "$keyword", which the checker does not understand');
      }
    }
  }

  static const Set<String> _objectKeywords = {
    'type',
    'properties',
    'required',
    'additionalProperties',
    'description',
  };

  static const Set<String> _propertyKeywords = {
    'type',
    'enum',
    'const',
    'pattern',
    'format',
    'minLength',
    'maxLength',
    'description',
  };
}
