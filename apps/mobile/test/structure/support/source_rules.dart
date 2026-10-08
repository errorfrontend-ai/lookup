import 'source_rule.dart';

/// The source scans of design §4.5, as data: one list for `lib/` and one for `test/`.
abstract final class SourceRules {
  /// The two button-address prefixes, the only web addresses `lib/` may hold (§3.7, §3.14).
  static const Map<String, Set<String>> allowedAddressLiterals = {
    'features/result/domain/action_uri_builder.dart': {
      'https://wa.me/',
      'https://www.google.com/maps/dir/?api=1&destination=',
    },
  };

  /// The rules for `lib/`.
  static final List<SourceRule> library = [
    SourceRule.stringPattern(
      'API address literal',
      pattern: RegExp(
        r'\b(?:https?|wss?)://(?:[A-Za-z0-9]|\[[0-9A-Fa-f:])'
        r'|(?<![\w.])(?:10\.0\.2\.2|127\.0\.0\.1|0\.0\.0\.0|localhost)(?![\w.])',
      ),
      reason:
          'the API address comes only from --dart-define (§3.7, S4-STRUCTURE-07); the only '
          'web addresses are the two button prefixes in action_uri_builder.dart',
      allowedLiterals: allowedAddressLiterals,
    ),
    SourceRule.codePattern(
      'print',
      pattern: RegExp(r'(?<![\w$])print\s*\('),
      reason: 'nothing is printed; development logging goes through DevelopmentLog (§3.19)',
    ),
    SourceRule.codePattern(
      'debugPrint outside development_log.dart',
      pattern: RegExp(r'(?<![\w$])debugPrint\b'),
      reason: 'only DevelopmentLog writes to the device log (§3.19, S4-PRIVACY-04)',
      exemptPaths: {'core/error_reporting/development_log.dart'},
    ),
    SourceRule.codePattern(
      'colour outside look_up_tokens.dart',
      pattern: RegExp(
        r'(?<![\w$])Color\s*\(\s*0[xX]|(?<![\w$])Color\.from(?:ARGB|RGBO)?\s*\(|'
        r'(?<![\w$])Colors\.',
      ),
      reason: 'colours come only from the generated tokens (§3.18, S4-THEME-01)',
      exemptPaths: {'core/theme/look_up_tokens.dart'},
    ),
    SourceRule.codePattern(
      'canLaunchUrl',
      pattern: RegExp(r'(?<![\w$])canLaunch(?:Url)?\b'),
      reason: 'the app never asks whether it can open an address; it tries (§3.14, S4-LINKS-10)',
    ),
    SourceRule.codePattern(
      'hasPermission',
      pattern: RegExp(r'(?<![\w$])hasPermission\s*\('),
      reason: "record's hasPermission() would show the system prompt itself (§3.16, S4-D22)",
    ),
    SourceRule.codePattern(
      'recorder started outside the recognition flow',
      // ClipRecorder.start({idempotencyKey, settings}), or a recorder made anywhere else.
      pattern: RegExp(
        r'(?<![\w$])(?:RecordClipRecorder|AudioRecorder)\s*\(|'
        r'\.start\s*\(\s*(?:idempotencyKey|settings)\s*:',
      ),
      reason: 'the recorder is started only by RecognitionFlow (§3.15, S4-PRIVACY-02)',
      exemptPaths: {
        'features/identify/data/clip_recorder.dart',
        'features/identify/data/clip_recorder_provider.dart',
        'features/identify/presentation/recognition_flow.dart',
      },
    ),
    SourceRule.codePattern(
      'recorder read by a screen',
      pattern: RegExp(r'(?<![\w$])clipRecorderProvider\b'),
      reason: 'screens reach the recorder only through RecognitionFlow (§3.15, S4-PRIVACY-02)',
      onlyPathsMatching: RegExp(r'^features/\w+/presentation/'),
      exemptPaths: {'features/identify/presentation/recognition_flow.dart'},
    ),
    SourceRule.codePattern(
      'setPreferredOrientations',
      pattern: RegExp(r'(?<![\w$])setPreferredOrientations\b'),
      reason: 'the app does not lock the orientation (§4.5)',
    ),
    SourceRule.codePattern(
      'blur',
      pattern: RegExp(r'(?<![\w$])(?:BackdropFilter|ImageFilter\.blur)\b'),
      reason: 'no blur: it is slow on low-end phones (§4.5)',
    ),
    SourceRule.codePattern(
      'device identifier',
      pattern: RegExp(
        r'(?<![\w$])(?:androidId|ANDROID_ID|getImei|imei|getDeviceId|getSerial|'
        r'AdvertisingIdClient|advertisingId|getAdvertisingId|identifierForVendor)\b',
      ),
      reason: 'no Android id, IMEI or advertising id is read (§3.17, §4.2)',
    ),
    SourceRule.stringPattern(
      'device identifier or media player package',
      pattern: RegExp(
        r'^package:(?:device_info_plus|android_id|advertising_id|flutter_udid|platform_device_id|'
        r'just_audio|audioplayers|video_player|flutter_sound|assets_audio_player|soundpool)/',
      ),
      reason: 'no device identifier and no audio or video player (§3.17, §4.5)',
    ),
    SourceRule.codePattern(
      'media player',
      pattern: RegExp(r'(?<![\w$])(?:AudioPlayer|VideoPlayerController|AudioCache)\b'),
      reason: 'the app plays no audio or video (§4.5)',
    ),
    SourceRule.codePattern(
      'fingerprinting code',
      pattern: RegExp(r'fingerprint|chromaprint|spectrogram', caseSensitive: false),
      reason: 'fingerprints are made on the server only (S3-ARCHITECTURE-09)',
    ),
    SourceRule.stringPattern(
      'key-like secret',
      pattern: secretPattern,
      reason: 'no secret is in the source (§3.7, S4-SECURITY-01)',
    ),
    SourceRule.imagesSetCacheWidth(),
    SourceRule.bannedDomainWords(),
    ..._sharedWithTests,
  ];

  /// The rules for `test/`.
  static final List<SourceRule> tests = [..._sharedWithTests];

  /// Text that looks like a real key or token (§4.5).
  static final RegExp secretPattern = RegExp(
    r'-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|'
    r'sk_(?:live|test)_[0-9A-Za-z]{10,}|xox[abprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[0-9A-Za-z]{30,}|'
    r'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.',
  );

  static final List<SourceRule> _sharedWithTests = [
    SourceRule.bannedShortWordsInNames(),
    SourceRule.codePattern(
      'one-letter catch',
      pattern: RegExp(
        r'\bcatch\s*\(\s*[A-Za-z_$]\s*[,)]|\bcatch\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$]\s*\)',
      ),
      reason: 'a caught error is named error, and its stack stackTrace (S4-NAMING-01)',
    ),
  ];
}
