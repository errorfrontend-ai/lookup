/// The project's naming rules as data (docs/conventions.md; design §4.5; S4-NAMING-01, -04, -05).
abstract final class NamingRules {
  /// Short forms that must never be a word of a file, type or other name (design §4.5).
  static const Set<String> bannedShortWords = {
    'req',
    'res',
    'err',
    'cfg',
    'ctx',
    'btn',
    'msg',
    'idx',
    'tmp',
    'val',
    'str',
    'len',
    'cnt',
  };

  /// Words the project replaced with its own domain words (S4-NAMING-05).
  static const Set<String> bannedDomainWords = {
    'tenant',
    'tenants',
    'customer',
    'customers',
    'spot',
    'spots',
    'payload',
    'payloads',
  };

  /// Library-mandated names the conventions accept as they are (docs/conventions.md).
  static const Set<String> acceptedLibraryNames = {
    'build',
    'context',
    'noiseSuppress',
    'autoGain',
    'bitRate',
  };

  static final RegExp _wordPattern = RegExp(r'[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+');

  /// The words of a camel-case or snake-case name, in lower case: `HTTPRequestId` gives
  /// `http`, `request`, `id`; `clip_recorder` gives `clip`, `recorder`.
  static List<String> wordsOf(String name) => [
    for (final match in _wordPattern.allMatches(name)) match.group(0)!.toLowerCase(),
  ];

  /// The banned short words in [name], empty when it has none or is an accepted library name.
  static List<String> bannedShortWordsIn(String name) => acceptedLibraryNames.contains(name)
      ? const []
      : [
          for (final word in wordsOf(name))
            if (bannedShortWords.contains(word)) word,
        ];

  /// The banned domain words in [name].
  static List<String> bannedDomainWordsIn(String name) => [
    for (final word in wordsOf(name))
      if (bannedDomainWords.contains(word)) word,
  ];

  /// The type name a file should hold: `look_up_tokens.dart` gives `LookUpTokens`.
  static String typeNameForFile(String fileName) {
    final baseName = fileName.endsWith('.dart')
        ? fileName.substring(0, fileName.length - '.dart'.length)
        : fileName;
    return [
      for (final word in baseName.split('_'))
        if (word.isNotEmpty) word[0].toUpperCase() + word.substring(1),
    ].join();
  }
}
