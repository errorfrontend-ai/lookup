import 'package:flutter_test/flutter_test.dart';

import '../support/repository_file_locator.dart';
import 'support/dart_source_tree.dart';
import 'support/layer_import_scan.dart';
import 'support/temporary_folder_copy.dart';

/// The layer rules of design §3.2 (S4-D2, S4-STRUCTURE-03), read from the import lines of `lib/`.
void main() {
  final libraryFolder = RepositoryFileLocator.mobileAppFolder('lib');

  test('every import in lib/features follows the layer rules', () {
    final scan = LayerImportScan.of(DartSourceTree.read(libraryFolder));

    for (final layer in CodeLayer.values) {
      expect(scan.filesByLayer[layer], greaterThan(0), reason: 'no ${layer.name} file was read');
    }
    expect(scan.directiveCount, greaterThanOrEqualTo(50));
    expect(scan.violations, isEmpty);
  });

  group('the import scan fails on a copy of lib/ where', () {
    late TemporaryFolderCopy copy;
    late LayerImportScan scan;

    setUpAll(() {
      copy = TemporaryFolderCopy.of(libraryFolder);
      // A data adapter of the result feature's kind: an interface and its provider in one file.
      copy.writeFile('features/result/data/planted_adapter.dart', '''
import 'package:flutter_riverpod/flutter_riverpod.dart';

abstract interface class PlantedAdapter {
  Future<bool> open(String address);
}

final Provider<PlantedAdapter> plantedAdapterProvider = Provider<PlantedAdapter>(
  (ref) => throw UnimplementedError(),
);
''');
      copy.writeFile('features/result/data/planted_helper.dart', '''
String plantedHelper(String text) => text;
''');
      for (final entry in _plantedFiles.entries) {
        copy.writeFile(entry.key, entry.value);
      }
      scan = LayerImportScan.of(DartSourceTree.read(copy.folder));
    });
    tearDownAll(() => copy.delete());

    List<String> violationsOf(String path) =>
        scan.violations.where((violation) => violation.startsWith('$path:')).toList();

    for (final path in _plantedFiles.keys.where((path) => !path.contains('allowed'))) {
      test('${path.split('/').last} breaks a rule', () {
        expect(violationsOf(path), isNotEmpty, reason: _plantedFiles[path]);
      });
    }

    test('presentation using only an adapter file\'s provider passes', () {
      expect(violationsOf(_allowedProviderUse), isEmpty);
    });

    test('the message names the type presentation must not use', () {
      expect(violationsOf(_adapterTypeUse).single, contains('uses PlantedAdapter'));
    });
  });
}

const String _allowedProviderUse = 'features/result/presentation/planted_allowed_provider.dart';
const String _adapterTypeUse = 'features/result/presentation/planted_adapter_type.dart';

/// Each file breaks one rule of §3.2, except [_allowedProviderUse], which shows what is allowed.
const Map<String, String> _plantedFiles = {
  'features/identify/presentation/planted_dio.dart': '''
import 'package:dio/dio.dart';

final Dio plantedClient = Dio();
''',
  'features/identify/presentation/planted_store.dart': '''
import 'package:shared_preferences/shared_preferences.dart' show SharedPreferences;
''',
  'features/identify/presentation/planted_recorder.dart': '''
import 'package:record/record.dart';
''',
  'features/identify/presentation/planted_permission.dart': '''
import 'package:permission_handler/permission_handler.dart';
''',
  'features/result/presentation/planted_launcher.dart': '''
import 'package:url_launcher/url_launcher.dart';
''',
  'features/identify/presentation/planted_path.dart': '''
import 'package:path_provider/path_provider.dart';
''',
  'features/identify/presentation/planted_input_output.dart': '''
import 'dart:io';
''',
  'features/identify/presentation/planted_request_builder.dart': '''
import '../data/recognize_request_builder.dart';
''',
  'features/result/presentation/planted_helper_use.dart': '''
import 'package:lookup_listener/features/result/data/planted_helper.dart';

String plantedText() => plantedHelper('text');
''',
  _adapterTypeUse: '''
import 'package:lookup_listener/features/result/data/planted_adapter.dart';

Future<bool> plantedOpen(PlantedAdapter adapter) => adapter.open('tel:+260977123456');
''',
  'features/result/presentation/planted_shown_type.dart': '''
import '../data/planted_adapter.dart' show PlantedAdapter, plantedAdapterProvider;
''',
  _allowedProviderUse: '''
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/result/data/planted_adapter.dart';

Future<bool> plantedOpen(WidgetRef ref) => ref.read(plantedAdapterProvider).open('tel:+260977123456');
''',
  'features/result/domain/planted_flutter.dart': '''
import 'package:flutter/foundation.dart';
''',
  'features/result/domain/planted_core.dart': '''
import '../../../core/time/clock.dart';
''',
  'features/identify/domain/planted_data.dart': '''
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
''',
  'features/identify/domain/planted_async.dart': '''
import 'dart:async';
''',
  'features/identify/data/planted_presentation.dart': '''
import '../presentation/recognition_flow.dart';
''',
  'features/result/data/planted_other_presentation.dart': '''
export 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
''',
};
