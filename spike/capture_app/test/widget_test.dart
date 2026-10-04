import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_capture/capture_settings.dart';
import 'package:lookup_capture/session_store.dart';
import 'package:record/record.dart';

void main() {
  const ready = CaptureSettings(adId: 'Brand-A Summer', device: 'Itel A70 (A13)', scene: 'vehicle');

  test('asks for the phone model and ad id before recording', () {
    expect(const CaptureSettings(adId: 'x').validate(), contains('phone model'));
    expect(const CaptureSettings(device: 'itel').validate(), contains('ad id'));
    expect(const CaptureSettings(device: 'itel', negative: true).validate(), isNull);
    expect(ready.validate(), isNull);
  });

  test('records with the exact encoder settings the listener app will ship', () {
    final config = ready.copyWith(bitRate: 32000, noiseSuppress: true, audioSource: AndroidAudioSource.voiceRecognition).toRecordConfig();
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
    final stem = ready.fileStem(DateTime(2026, 9, 30, 7, 5, 9), 2);
    expect(stem, 'itel-a70-a13_vehicle_brand-a-summer_8s_mic-ns-off-agc-off_aac24_20260930T070509_t2');
    expect(RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(stem), isTrue); // no spaces, slashes or brackets
  });

  test('manifest rows line up with the benchmark columns', () {
    final at = DateTime(2026, 9, 30, 7, 5, 9);
    final query = ready.manifestRow('clip.m4a', at);
    final negative = ready.copyWith(negative: true).manifestRow('neg.m4a', at);
    expect(query.length, manifestHeader.length);
    expect(query.sublist(0, 9), ['query', 'clip.m4a', 'Brand-A Summer', 'Itel A70 (A13)', 'vehicle', '8', 'aac24', '', 'mic/ns-off/agc-off']);
    expect(negative[0], 'negative');
    expect(negative[2], isEmpty);
  });

  test('csv cells with commas or quotes are escaped', () {
    expect(csvLine(['a', 'b,c', 'say "hi"']), 'a,"b,c","say ""hi"""');
  });

  test('reads back quoted csv cells', () {
    expect(parseCsvLine('query,a.m4a,"brand, a","say ""hi""",8'), ['query', 'a.m4a', 'brand, a', 'say "hi"', '8']);
    expect(parseCsvLine(csvLine(['x', 'y,z', 'q"r'])), ['x', 'y,z', 'q"r']);
  });

  test('sessions are listed newest first and know when they started', () async {
    final base = await Directory.systemTemp.createTemp('capture_list');
    addTearDown(() => base.delete(recursive: true));
    await SessionStore.inDirectory(base, DateTime(2026, 10, 1, 9, 0, 0));
    await SessionStore.inDirectory(base, DateTime(2026, 10, 2, 7, 5, 9));
    final sessions = await SessionStore.listIn(base);
    expect(sessions.map((s) => s.name), ['session_20261002T070509', 'session_20261001T090000']);
    expect(sessions.first.startedAt, DateTime(2026, 10, 2, 7, 5, 9));
    expect(await SessionStore.listIn(Directory('${base.path}/missing')), isEmpty);
  });

  test('clips come back newest first with their labels, and delete removes file and row', () async {
    final base = await Directory.systemTemp.createTemp('capture_clips');
    addTearDown(() => base.delete(recursive: true));
    final store = await SessionStore.inDirectory(base, DateTime(2026, 10, 2, 7, 5, 9));
    final comma = ready.copyWith(adId: 'brand, a');
    for (final (i, s) in [(1, ready), (2, comma), (3, ready.copyWith(negative: true))]) {
      final at = DateTime(2026, 10, 2, 7, 6, i);
      final stem = s.fileStem(at, 1);
      await File(store.pathFor(stem)).writeAsBytes([0, 1, 2]);
      await store.addRow(s.manifestRow('$stem.m4a', at));
    }

    var infos = await store.clipInfos();
    expect(infos.map((c) => c.title), ['Not an ad · 8 s', 'brand, a · 8 s', 'Brand-A Summer · 8 s']);
    expect(infos.last.details, startsWith('vehicle · mic/ns-off/agc-off · '));

    await store.deleteClip(infos[1].file);
    infos = await store.clipInfos();
    expect(infos.map((c) => c.title), ['Not an ad · 8 s', 'Brand-A Summer · 8 s']);
    final lines = (await store.manifest.readAsLines()).where((l) => l.isNotEmpty).toList();
    expect(lines, hasLength(3)); // header + the two clips still on disk
    expect(lines.any((l) => l.contains('brand, a')), isFalse);
  });

  test('newest recording is listed first even when its name sorts earlier', () async {
    final base = await Directory.systemTemp.createTemp('capture_order');
    addTearDown(() => base.delete(recursive: true));
    final store = await SessionStore.inDirectory(base, DateTime(2026, 10, 4, 8, 0, 0));
    // 'zebra' recorded first, then 'apple' (two takes): alphabetical order is the opposite.
    final takes = [
      (ready.copyWith(adId: 'zebra'), DateTime(2026, 10, 4, 8, 1, 0), 1),
      (ready.copyWith(adId: 'apple'), DateTime(2026, 10, 4, 8, 2, 0), 1),
      (ready.copyWith(adId: 'apple'), DateTime(2026, 10, 4, 8, 2, 0), 2),
    ];
    for (final (s, at, take) in takes) {
      final stem = s.fileStem(at, take);
      await File(store.pathFor(stem)).writeAsBytes([0]);
      await store.addRow(s.manifestRow('$stem.m4a', at));
    }
    final infos = await store.clipInfos();
    expect(infos.map((c) => c.file.uri.pathSegments.last.split('_').last), ['t2.m4a', 't1.m4a', 't1.m4a']);
    expect(infos.map((c) => c.title), ['apple · 8 s', 'apple · 8 s', 'zebra · 8 s']);
  });

  test('a session writes the header once, then one row per clip', () async {
    final base = await Directory.systemTemp.createTemp('capture_test');
    addTearDown(() => base.delete(recursive: true));
    final store = await SessionStore.inDirectory(base, DateTime(2026, 9, 30, 7, 5, 9));
    await store.addRow(ready.manifestRow('one.m4a', DateTime(2026, 9, 30)));
    await store.addRow(ready.manifestRow('two.m4a', DateTime(2026, 9, 30)));
    final lines = await store.manifest.readAsLines();
    expect(lines.first, manifestHeader.join(','));
    expect(lines, hasLength(3));
    expect(store.name, 'session_20260930T070509');
  });
}
