import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/data_use/data_use_meter.dart';
import 'package:lookup_listener/core/files/owned_lock_file.dart';

import '../../support/fake_clock.dart';
import '../../support/recording_client_error_reporter.dart';

const LockFileOwner _foreground = LockFileOwner(
  processId: 4242,
  engineId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
);
const LockFileOwner _background = LockFileOwner(
  processId: 4242,
  engineId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
);

/// "Used this month" (P6 design §3.16; P6-DATASAVER-03, Q11, P6-D45).
void main() {
  late Directory folder;
  late FakeClock clock;
  late RecordingClientErrorReporter reporter;

  setUp(() {
    folder = Directory.systemTemp.createTempSync('data_use_meter_test_');
    addTearDown(() {
      if (folder.existsSync()) folder.deleteSync(recursive: true);
    });
    // 31 October 2026, late evening, on the phone.
    clock = FakeClock(startsAt: DateTime(2026, 10, 31, 22).toUtc());
    reporter = RecordingClientErrorReporter();
  });

  DataUseMeter meterFor(LockFileOwner owner, {Directory? at}) => DataUseMeter(
    locateFolder: () async => at ?? folder,
    lockOwner: owner,
    lockTakeOver: LocalLockTakeOver.everyEngineAttached(),
    clock: clock,
    clientErrorReporter: reporter,
  );

  test('three identifies of known size in October add up to their sum, and November starts again '
      'at 0 (P6-DATASAVER-03)', () async {
    final meter = meterFor(_foreground);
    expect(await meter.bytesThisMonth(), 0);
    for (final bytes in [28412, 29105, 27980]) {
      await meter.add(bytes);
    }
    expect(await meter.bytesThisMonth(), 28412 + 29105 + 27980);

    clock.advance(const Duration(hours: 3)); // 1 November, 01:00 on the phone
    expect(await meter.bytesThisMonth(), 0);
    await meter.add(1000);
    expect(await meter.bytesThisMonth(), 1000);
  });

  test(
    'the count is kept on disk, in the data_use folder, and read again after a restart',
    () async {
      await meterFor(_foreground).add(5000);
      expect(await meterFor(_foreground).bytesThisMonth(), 5000);
      expect(DataUseMeter.folderIn(Directory('/support')).path, '/support/data_use');
      expect(File('${folder.path}/data-use.json').existsSync(), isTrue);
    },
  );

  test('the foreground and background engines both add, and neither loses the other\'s bytes '
      '(P6-D45)', () async {
    final foreground = meterFor(_foreground);
    final background = meterFor(_background);
    await Future.wait([
      for (var send = 0; send < 10; send++) ...[foreground.add(100), background.add(10)],
    ]);
    expect(await foreground.bytesThisMonth(), 1100);
    expect(await background.bytesThisMonth(), 1100);
  });

  test('each addition is announced, so Settings shows the new count', () async {
    final meter = meterFor(_foreground);
    var changes = 0;
    meter.changed.listen((_) => changes++);
    await meter.add(10);
    await meter.add(0);
    await Future<void>.delayed(Duration.zero);
    expect(changes, 1, reason: 'nothing added, nothing announced');
  });

  test('a file that cannot be read starts the month again', () async {
    File('${folder.path}/data-use.json').writeAsStringSync('not json');
    final meter = meterFor(_foreground);
    expect(await meter.bytesThisMonth(), 0);
    await meter.add(42);
    expect(await meter.bytesThisMonth(), 42);
  });

  test('a meter that cannot write never throws, and reports once', () async {
    final notAFolder = File('${folder.path}/in-the-way')..writeAsStringSync('');
    final meter = meterFor(_foreground, at: Directory('${notAFolder.path}/data_use'));
    await meter.add(100);
    await meter.add(100);
    expect(await meter.bytesThisMonth(), 0);
    expect(reporter.reports.map((report) => report.description), ['Counting the data used failed']);
  });

  test('a month is the phone\'s calendar month', () {
    expect(DataUseMeter.monthOf(DateTime(2026, 10, 31, 23, 59)), '2026-10');
    expect(DataUseMeter.monthOf(DateTime(2026, 11, 1)), '2026-11');
  });
}
