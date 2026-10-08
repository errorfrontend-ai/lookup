import 'dart_source_tree.dart';
import 'naming_rules.dart';

/// The naming rules for files and types (docs/conventions.md; S4-NAMING-01, -04): no banned short
/// word in a file name or a type name, and each file that declares public types declares one named
/// after the file (`recognition_state.dart` holds `RecognitionState`).
final class FileAndTypeNameScan {
  FileAndTypeNameScan._(this.fileCount, this.typeCount, this.mainTypeFileCount, this.violations);

  /// Checks every file of [tree]. With [checksMainType], also checks that each file declaring
  /// public types holds one named after it; [mainTypeExemptPaths] are left out of that check.
  factory FileAndTypeNameScan.of(
    DartSourceTree tree, {
    required bool checksMainType,
    Set<String> mainTypeExemptPaths = const {},
  }) {
    var typeCount = 0;
    var mainTypeFileCount = 0;
    final violations = <String>[];
    for (final file in tree.files) {
      final fileWords = NamingRules.bannedShortWordsIn(file.fileName.replaceAll('.dart', ''));
      if (fileWords.isNotEmpty) {
        violations.add('${file.path}: the file name uses ${fileWords.join(', ')} (S4-NAMING-01)');
      }
      for (final declaration in file.typeDeclarations) {
        typeCount++;
        final typeWords = NamingRules.bannedShortWordsIn(declaration.name);
        if (typeWords.isNotEmpty) {
          violations.add(
            '${file.path}:${declaration.lineNumber} ${declaration.name} uses '
            '${typeWords.join(', ')} (S4-NAMING-01)',
          );
        }
      }
      if (!checksMainType || mainTypeExemptPaths.contains(file.path)) continue;
      final publicTypes = file.typeDeclarations.where((declaration) => declaration.isPublic);
      if (publicTypes.isEmpty) continue;
      mainTypeFileCount++;
      final expectedName = NamingRules.typeNameForFile(file.fileName);
      if (!publicTypes.any((declaration) => declaration.name == expectedName)) {
        violations.add(
          '${file.path}: declares ${publicTypes.map((declaration) => declaration.name).join(', ')} '
          'but no $expectedName; each file is named after its one main type (S4-NAMING-04)',
        );
      }
    }
    return FileAndTypeNameScan._(tree.files.length, typeCount, mainTypeFileCount, violations);
  }

  /// How many files were read.
  final int fileCount;

  /// How many type declarations were read.
  final int typeCount;

  /// How many files declared public types and so had their main type checked.
  final int mainTypeFileCount;

  /// One line per broken rule.
  final List<String> violations;
}
