import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_capture/capture_settings.dart';
import 'package:lookup_capture/session_store.dart';
import 'package:record/record.dart';

void main() {
  const readySettings = CaptureSettings(adId: 'Brand-A Summer', device: 'Itel A70 (A13)', scene: 'vehicle');

  test('asks for the phone model and ad id before recording', () {
    expect(const CaptureSettings(adId: 'x').validate(), contains('phone model'));
    expect(const CaptureSettings(device: 'itel').validate(), contains('ad id'));
    expect(const CaptureSettings(device: 'itel', isNegative: true).validate(), isNull);
    expect(readySettings.validate(), isNull);
  });

  test('records with the exact encoder settings the listener app will ship', () {
    final config = readySettings
        .copyWith(bitRate: 32000, noiseSuppress: true, audioSource: AndroidAudioSource.voiceRecognition)
        .toRecordConfig();
    expect(config.encoder, AudioEncoder.aacLc);
    expect(config.sampleRate, 16000);
    expect(config.numChannels, 1);
    expect(config.bitRate, 32000);
    expect(config.noiseSuppress, isTrue);
    expect(config.autoGain, isFalse);
    expect(config.echoCancel, isFalse);
    expect(config.androidConfig.audioSource, AndroidAudioSource.voiceRecognition);
    expect(config.androidConfig.manageBluetooth, isFalse);
  });

  test('file names are safe and carry every label the benchmark groups by', () {
    final recordedAt = DateTime(2026, 9, 30, 7, 5, 9);
    final fileStem = readySettings.buildFileStem(recordedAt, 2);
    expect(fileStem, 'itel-a70-a13_vehicle_brand-a-summer_8s_mic-ns-off-agc-off_aac24_20260930T070509_t2');
    expect(RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(fileStem), isTrue); // no spaces, slashes or brackets
    expect(readySettings.copyWith(isNegative: true).buildFileStem(recordedAt, 1),
        'itel-a70-a13_vehicle_neg_8s_mic-ns-off-agc-off_aac24_20260930T070509_t1');
  });

  test('manifest rows line up with the benchmark columns', () {
    expect(manifestHeader, [
      'role', 'path', 'ad_id', 'device', 'scene',
      'clip_seconds', 'codec', 'reference_variant', 'microphone_settings', 'notes',
    ]);
    final recordedAt = DateTime(2026, 9, 30, 7, 5, 9);
    final queryRow = readySettings.buildManifestRow('clip.m4a', recordedAt);
    final negativeRow = readySettings.copyWith(isNegative: true).buildManifestRow('neg.m4a', recordedAt);
    expect(queryRow.length, manifestHeader.length);
    expect(queryRow.sublist(0, 9), ['query', 'clip.m4a', 'Brand-A Summer', 'Itel A70 (A13)', 'vehicle', '8', 'aac24', '', 'mic/ns-off/agc-off']);
    expect(negativeRow[0], 'negative');
    expect(negativeRow[2], isEmpty);
  });

  test('csv cells with commas or quotes are escaped', () {
    expect(formatCsvLine(['a', 'b,c', 'say "hi"']), 'a,"b,c","say ""hi"""');
  });

  test('reads back quoted csv cells', () {
    expect(parseCsvLine('query,a.m4a,"brand, a","say ""hi""",8'), ['query', 'a.m4a', 'brand, a', 'say "hi"', '8']);
    expect(parseCsvLine(formatCsvLine(['x', 'y,z', 'q"r'])), ['x', 'y,z', 'q"r']);
  });

  test('sessions are listed newest first and know when they started', () async {
    final baseDirectory = await Directory.systemTemp.createTemp('capture_list');
    addTearDown(() => baseDirectory.delete(recursive: true));
    await SessionStore.createInDirectory(baseDirectory, DateTime(2026, 10, 1, 9, 0, 0));
    await SessionStore.createInDirectory(baseDirectory, DateTime(2026, 10, 2, 7, 5, 9));
    final sessions = await SessionStore.listInDirectory(baseDirectory);
    expect(sessions.map((session) => session.name), ['session_20261002T070509', 'session_20261001T090000']);
    expect(sessions.first.startedAt, DateTime(2026, 10, 2, 7, 5, 9));
    expect(await SessionStore.listInDirectory(Directory('${baseDirectory.path}/missing')), isEmpty);
  });

  test('clips come back newest first with their labels, and delete removes file and row', () async {
    final baseDirectory = await Directory.systemTemp.createTemp('capture_clips');
    addTearDown(() => baseDirectory.delete(recursive: true));
    final session = await SessionStore.createInDirectory(baseDirectory, DateTime(2026, 10, 2, 7, 5, 9));
    final settingsWithComma = readySettings.copyWith(adId: 'brand, a');
    final recordings = [(1, readySettings), (2, settingsWithComma), (3, readySettings.copyWith(isNegative: true))];
    for (final (second, settings) in recordings) {
      final recordedAt = DateTime(2026, 10, 2, 7, 6, second);
      final fileStem = settings.buildFileStem(recordedAt, 1);
      await File(session.buildClipPath(fileStem)).writeAsBytes([0, 1, 2]);
      await session.appendManifestRow(settings.buildManifestRow('$fileStem.m4a', recordedAt));
    }

    var labelledClips = await session.listLabelledClips();
    expect(labelledClips.map((clip) => clip.title), ['Not an ad · 8 s', 'brand, a · 8 s', 'Brand-A Summer · 8 s']);
    expect(labelledClips.last.details, startsWith('vehicle · mic/ns-off/agc-off · '));

    await session.deleteClip(labelledClips[1].file);
    labelledClips = await session.listLabelledClips();
    expect(labelledClips.map((clip) => clip.title), ['Not an ad · 8 s', 'Brand-A Summer · 8 s']);
    final lines = (await session.manifest.readAsLines()).where((line) => line.isNotEmpty).toList();
    expect(lines, hasLength(3)); // header + the two clips still on disk
    expect(lines.any((line) => line.contains('brand, a')), isFalse);
  });

  test('a session recorded with the old column names still shows its labels', () async {
    final baseDirectory = await Directory.systemTemp.createTemp('capture_legacy');
    addTearDown(() => baseDirectory.delete(recursive: true));
    final session = await SessionStore.createInDirectory(baseDirectory, DateTime(2026, 9, 30, 7, 5, 9));
    const legacyHeader = 'role,path,ad_id,device,scene,clip_s,codec,ref_variant,mic,notes';
    final firstRecordedAt = DateTime(2026, 9, 30, 7, 6, 0);
    final firstFileStem = readySettings.buildFileStem(firstRecordedAt, 1);
    await File(session.buildClipPath(firstFileStem)).writeAsBytes([0]);
    await session.manifest.writeAsString(
        '$legacyHeader\n${formatCsvLine(readySettings.buildManifestRow('$firstFileStem.m4a', firstRecordedAt))}\n');

    // A clip recorded after the update goes under the session's old header; the column order
    // never changed, and the benchmark import maps the old names.
    final negativeSettings = readySettings.copyWith(isNegative: true);
    final secondRecordedAt = DateTime(2026, 9, 30, 7, 7, 0);
    final secondFileStem = negativeSettings.buildFileStem(secondRecordedAt, 1);
    await File(session.buildClipPath(secondFileStem)).writeAsBytes([0]);
    await session.appendManifestRow(negativeSettings.buildManifestRow('$secondFileStem.m4a', secondRecordedAt));

    final labelledClips = await session.listLabelledClips();
    expect(labelledClips.map((clip) => clip.title), ['Not an ad · 8 s', 'Brand-A Summer · 8 s']);
    expect(labelledClips.last.details, startsWith('vehicle · mic/ns-off/agc-off · '));
    final lines = await session.manifest.readAsLines();
    expect(lines.first, legacyHeader);
    expect(lines, hasLength(3)); // the header is not written a second time

    await session.deleteClip(labelledClips.first.file);
    expect(await session.manifest.readAsLines(), hasLength(2));
  });

  test('newest recording is listed first even when its name sorts earlier', () async {
    final baseDirectory = await Directory.systemTemp.createTemp('capture_order');
    addTearDown(() => baseDirectory.delete(recursive: true));
    final session = await SessionStore.createInDirectory(baseDirectory, DateTime(2026, 10, 4, 8, 0, 0));
    // 'zebra' recorded first, then 'apple' (two takes): alphabetical order is the opposite.
    final recordings = [
      (readySettings.copyWith(adId: 'zebra'), DateTime(2026, 10, 4, 8, 1, 0), 1),
      (readySettings.copyWith(adId: 'apple'), DateTime(2026, 10, 4, 8, 2, 0), 1),
      (readySettings.copyWith(adId: 'apple'), DateTime(2026, 10, 4, 8, 2, 0), 2),
    ];
    for (final (settings, recordedAt, takeNumber) in recordings) {
      final fileStem = settings.buildFileStem(recordedAt, takeNumber);
      await File(session.buildClipPath(fileStem)).writeAsBytes([0]);
      await session.appendManifestRow(settings.buildManifestRow('$fileStem.m4a', recordedAt));
    }
    final labelledClips = await session.listLabelledClips();
    expect(labelledClips.map((clip) => clip.file.uri.pathSegments.last.split('_').last), ['t2.m4a', 't1.m4a', 't1.m4a']);
    expect(labelledClips.map((clip) => clip.title), ['apple · 8 s', 'apple · 8 s', 'zebra · 8 s']);
  });

  test('a session writes the header once, then one row per clip', () async {
    final baseDirectory = await Directory.systemTemp.createTemp('capture_test');
    addTearDown(() => baseDirectory.delete(recursive: true));
    final session = await SessionStore.createInDirectory(baseDirectory, DateTime(2026, 9, 30, 7, 5, 9));
    await session.appendManifestRow(readySettings.buildManifestRow('one.m4a', DateTime(2026, 9, 30)));
    await session.appendManifestRow(readySettings.buildManifestRow('two.m4a', DateTime(2026, 9, 30)));
    final lines = await session.manifest.readAsLines();
    expect(lines.first, 'role,path,ad_id,device,scene,clip_seconds,codec,reference_variant,microphone_settings,notes');
    expect(lines, hasLength(3));
    expect(session.name, 'session_20260930T070509');
  });
}
