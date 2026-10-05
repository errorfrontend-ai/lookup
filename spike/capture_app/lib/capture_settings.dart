import 'package:record/record.dart';

/// Scene labels from spike/README.md — keep the two in sync.
const scenes = ['quiet', 'far-low', 'vehicle', 'market', 'weak-fm'];
const clipLengthsSeconds = [3, 5, 8, 10];
const bitRatesBitsPerSecond = [24000, 32000];

/// Android audio sources worth comparing in Phase 0. Each applies different
/// built-in processing on different phones, which can change what the
/// fingerprint engine hears.
const audioSources = [
  AndroidAudioSource.mic,
  AndroidAudioSource.voiceRecognition,
  AndroidAudioSource.unprocessed,
  AndroidAudioSource.camcorder,
  AndroidAudioSource.defaultSource,
];

/// Columns of the benchmark manifest (services/fingerprinter/bench/manifest.py).
const manifestHeader = [
  'role', 'path', 'ad_id', 'device', 'scene',
  'clip_seconds', 'codec', 'reference_variant', 'microphone_settings', 'notes',
];

/// Columns renamed since the first sessions were recorded (old name -> current name). A session
/// started before the rename keeps its old header (the column order never changed, so new rows
/// still line up); whatever reads a manifest maps the old names to the current ones.
const legacyManifestColumnNames = {
  'clip_s': 'clip_seconds',
  'ref_variant': 'reference_variant',
  'mic': 'microphone_settings',
};

class CaptureSettings {
  const CaptureSettings({
    this.adId = '',
    this.isNegative = false,
    this.device = '',
    this.scene = 'quiet',
    this.clipSeconds = 8,
    this.takeCount = 1,
    this.bitRate = 24000,
    this.noiseSuppress = false,
    this.autoGain = false,
    this.audioSource = AndroidAudioSource.mic,
  });

  /// Same encoder settings the Look Up listener app will ship (plan: AAC-LC, 16 kHz, mono).
  static const sampleRateHertz = 16000;

  final String adId;
  final bool isNegative;
  final String device;
  final String scene;
  final int clipSeconds;
  final int takeCount;
  final int bitRate;
  final bool noiseSuppress;
  final bool autoGain;
  final AndroidAudioSource audioSource;

  String get role => isNegative ? 'negative' : 'query';
  String get codecLabel => 'aac${bitRate ~/ 1000}';
  String get microphoneSettingsLabel =>
      '${audioSource.name}/ns-${noiseSuppress ? 'on' : 'off'}/agc-${autoGain ? 'on' : 'off'}';

  /// A plain-language problem, or null when ready to record.
  String? validate() {
    if (toSlug(device).isEmpty) return 'Enter the phone model first, e.g. itel-a70-a13.';
    if (!isNegative && toSlug(adId).isEmpty) return 'Enter the ad id, or mark this as not an ad.';
    return null;
  }

  RecordConfig toRecordConfig() => RecordConfig(
        encoder: AudioEncoder.aacLc,
        sampleRate: sampleRateHertz,
        numChannels: 1,
        bitRate: bitRate,
        noiseSuppress: noiseSuppress,
        autoGain: autoGain,
        echoCancel: false,
        androidConfig: AndroidRecordConfig(
          audioSource: audioSource,
          manageBluetooth: false, // a paired headset must not silently replace the phone mic
        ),
      );

  String buildFileStem(DateTime recordedAt, int takeNumber) => [
        toSlug(device),
        scene,
        isNegative ? 'neg' : toSlug(adId),
        '${clipSeconds}s',
        microphoneSettingsLabel.replaceAll('/', '-'),
        codecLabel,
        formatTimestamp(recordedAt),
        't$takeNumber',
      ].join('_');

  List<String> buildManifestRow(String relativePath, DateTime recordedAt) => [
        role,
        relativePath,
        isNegative ? '' : adId.trim(),
        device.trim(),
        scene,
        '$clipSeconds',
        codecLabel,
        '',
        microphoneSettingsLabel,
        'captured ${recordedAt.toIso8601String()}',
      ];

  CaptureSettings copyWith({
    String? adId,
    bool? isNegative,
    String? device,
    String? scene,
    int? clipSeconds,
    int? takeCount,
    int? bitRate,
    bool? noiseSuppress,
    bool? autoGain,
    AndroidAudioSource? audioSource,
  }) =>
      CaptureSettings(
        adId: adId ?? this.adId,
        isNegative: isNegative ?? this.isNegative,
        device: device ?? this.device,
        scene: scene ?? this.scene,
        clipSeconds: clipSeconds ?? this.clipSeconds,
        takeCount: takeCount ?? this.takeCount,
        bitRate: bitRate ?? this.bitRate,
        noiseSuppress: noiseSuppress ?? this.noiseSuppress,
        autoGain: autoGain ?? this.autoGain,
        audioSource: audioSource ?? this.audioSource,
      );
}

String toSlug(String value) => value
    .trim()
    .toLowerCase()
    .replaceAll(RegExp(r'[^a-z0-9.]+'), '-')
    .replaceAll(RegExp(r'^-+|-+$'), '');

String formatTimestamp(DateTime time) {
  String twoDigits(int number) => number.toString().padLeft(2, '0');
  return '${time.year}${twoDigits(time.month)}${twoDigits(time.day)}'
      'T${twoDigits(time.hour)}${twoDigits(time.minute)}${twoDigits(time.second)}';
}

String escapeCsvCell(String value) =>
    (value.contains(',') || value.contains('"') || value.contains('\n'))
        ? '"${value.replaceAll('"', '""')}"'
        : value;

String formatCsvLine(List<String> cells) => cells.map(escapeCsvCell).join(',');
