import 'package:record/record.dart';

/// Scene labels from spike/README.md — keep the two in sync.
const scenes = ['quiet', 'far-low', 'vehicle', 'market', 'weak-fm'];
const clipLengths = [3, 5, 8, 10];
const bitRates = [24000, 32000];

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
  'role', 'path', 'ad_id', 'device', 'scene', 'clip_s', 'codec', 'ref_variant', 'mic', 'notes',
];

class CaptureSettings {
  const CaptureSettings({
    this.adId = '',
    this.negative = false,
    this.device = '',
    this.scene = 'quiet',
    this.clipSeconds = 8,
    this.takes = 1,
    this.bitRate = 24000,
    this.noiseSuppress = false,
    this.autoGain = false,
    this.audioSource = AndroidAudioSource.mic,
  });

  /// Same encoder settings the Look Up listener app will ship (plan: AAC-LC, 16 kHz, mono).
  static const sampleRate = 16000;

  final String adId;
  final bool negative;
  final String device;
  final String scene;
  final int clipSeconds;
  final int takes;
  final int bitRate;
  final bool noiseSuppress;
  final bool autoGain;
  final AndroidAudioSource audioSource;

  String get role => negative ? 'negative' : 'query';
  String get codecLabel => 'aac${bitRate ~/ 1000}';
  String get micLabel =>
      '${audioSource.name}/ns-${noiseSuppress ? 'on' : 'off'}/agc-${autoGain ? 'on' : 'off'}';

  /// A plain-language problem, or null when ready to record.
  String? validate() {
    if (slug(device).isEmpty) return 'Enter the phone model first, e.g. itel-a70-a13.';
    if (!negative && slug(adId).isEmpty) return 'Enter the ad id, or mark this as not an ad.';
    return null;
  }

  RecordConfig toRecordConfig() => RecordConfig(
        encoder: AudioEncoder.aacLc,
        sampleRate: sampleRate,
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

  String fileStem(DateTime at, int take) => [
        slug(device),
        scene,
        negative ? 'neg' : slug(adId),
        '${clipSeconds}s',
        micLabel.replaceAll('/', '-'),
        codecLabel,
        stamp(at),
        't$take',
      ].join('_');

  List<String> manifestRow(String relativePath, DateTime at) => [
        role,
        relativePath,
        negative ? '' : adId.trim(),
        device.trim(),
        scene,
        '$clipSeconds',
        codecLabel,
        '',
        micLabel,
        'captured ${at.toIso8601String()}',
      ];

  CaptureSettings copyWith({
    String? adId,
    bool? negative,
    String? device,
    String? scene,
    int? clipSeconds,
    int? takes,
    int? bitRate,
    bool? noiseSuppress,
    bool? autoGain,
    AndroidAudioSource? audioSource,
  }) =>
      CaptureSettings(
        adId: adId ?? this.adId,
        negative: negative ?? this.negative,
        device: device ?? this.device,
        scene: scene ?? this.scene,
        clipSeconds: clipSeconds ?? this.clipSeconds,
        takes: takes ?? this.takes,
        bitRate: bitRate ?? this.bitRate,
        noiseSuppress: noiseSuppress ?? this.noiseSuppress,
        autoGain: autoGain ?? this.autoGain,
        audioSource: audioSource ?? this.audioSource,
      );
}

String slug(String value) => value
    .trim()
    .toLowerCase()
    .replaceAll(RegExp(r'[^a-z0-9.]+'), '-')
    .replaceAll(RegExp(r'^-+|-+$'), '');

String stamp(DateTime t) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.year}${two(t.month)}${two(t.day)}T${two(t.hour)}${two(t.minute)}${two(t.second)}';
}

String csvCell(String value) =>
    (value.contains(',') || value.contains('"') || value.contains('\n'))
        ? '"${value.replaceAll('"', '""')}"'
        : value;

String csvLine(List<String> cells) => cells.map(csvCell).join(',');
