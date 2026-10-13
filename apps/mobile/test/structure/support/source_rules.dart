import '../../support/contract_fixtures.dart';
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
    SourceRule.imagesSetDecodeSize(),
    SourceRule.codePattern(
      'image that may follow a redirect to http',
      pattern: RegExp(r'(?<![\w$.])(?:Image\.network|NetworkImage)\s*\('),
      reason:
          'images load through HttpsImageProvider, which follows a redirect only to another https '
          'address; Image.network lets the client follow one to plain http (§3.7, S4-D15)',
    ),
    SourceRule.animationDurationsFromMotionTokens(onlyPathsMatching: _widgetCode),
    SourceRule.codePattern(
      'animation other than scale or opacity',
      pattern: RegExp(
        r'(?<![\w$.])(?:Animated(?!Scale\b|Opacity\b)[A-Z]\w*|'
        r'(?!(?:Scale|Fade)Transition\b)[A-Z]\w*Transition\b|TweenAnimationBuilder\b|'
        r'ImplicitlyAnimatedWidget\b|Hero\s*\()',
      ),
      reason:
          'only a transform or the opacity animates (ScaleTransition, AnimatedScale, '
          'FadeTransition, AnimatedOpacity): they cost a cheap phone no layout (§4.5)',
    ),
    SourceRule.stringPattern(
      'campaign label or phone number',
      pattern: campaignLiteralPattern,
      reason:
          'every button, label and number on a result comes from the action card in the answer; '
          'the app writes none of its own (S4-RENDERER-01)',
      allowedLiterals: allowedCampaignLikeLiterals,
    ),
    SourceRule.bannedDomainWords(),
    SourceRule.wordsOutsideLanguageFiles(
      onlyPathsMatching: _outsideLanguageFiles,
      widgetCode: _widgetCode,
      allowedLiterals: allowedNeverShownLiterals,
    ),
    SourceRule.codePattern(
      'MediaQuery.of(context).size',
      pattern: RegExp(r'(?<![\w$])MediaQuery\s*\.\s*of\s*\([^()]*\)\s*\.\s*size\b'),
      reason:
          'widths are read with MediaQuery.sizeOf, and layouts ask WindowSizeClass.of, so a '
          'widget rebuilds only when the size changes (§3.19, P6-RESPONSIVE-02)',
    ),
    SourceRule.codePattern(
      'a theme mode other than the phone\'s',
      pattern: RegExp(r'(?<![\w$])ThemeMode\s*\.\s*(?:light|dark)\b'),
      reason:
          'the app follows the phone\'s light or dark setting: ThemeMode.system (§3.18, '
          'P6-THEME-01)',
    ),
    ..._sharedWithTests,
  ];

  /// Every file but the language files themselves (`lib/l10n/`).
  static final RegExp _outsideLanguageFiles = RegExp(r'^(?!l10n/)');

  /// Literals the words rule would take for words on a screen that no screen shows, by path: the
  /// support chat's address is built as a WhatsApp action, whose label no screen draws; the routes'
  /// paths; what a crash report says went wrong, which goes to the developers; the phone's own
  /// monospace font names; and the test error's own words, which only its crash report carries.
  static const Map<String, Set<String>> allowedNeverShownLiterals = {
    'features/identify/domain/support_chat_address.dart': {'Message support on WhatsApp'},
    'app/app_route.dart': _routePaths,
    'features/identify/presentation/recognition_flow.dart': {
      ..._routePaths,
      'Asking for the microphone failed',
      'Opening the phone settings failed',
      'Reading the microphone permission failed',
      'The recorder could not start',
      'The recorder failed while recording',
      'The recorder could not finish the clip',
      'Sending the clip failed on the phone',
      'Reading the microphone permission on return failed',
      'Reading My station for the hint failed',
      'Queueing the station choice failed',
      'Remembering My station failed',
      'Saving the result to History failed',
      'Keeping the clip for later failed',
    },
    'app/bootstrap.dart': {'Deleting old History entries at start failed'},
    // The crash report's description when a report cannot be queued (P6 design §2.14).
    'app/outbox_recognition_reporting.dart': {'Queueing the report failed'},
    // The background job (P6 design §3.10): WorkManager's work names, the port's name, the entry
    // point's pragma, and what its crash reports say went wrong.
    'app/background_work_scheduler.dart': {'look-up-outbox-send', 'look-up-outbox-expiry'},
    'app/outbox_background_coordinator.dart': {
      'look-up-outbox',
      'Scheduling the outbox expiry job failed',
      'Scheduling the outbox send job failed',
    },
    'app/outbox_background_task.dart': {
      'vm:entry-point',
      'The outbox background job failed',
      'Scheduling the outbox expiry job failed',
    },
    'features/identify/presentation/reference_code_panel.dart': {'monospace', 'Menlo', 'Courier'},
    'features/identify/presentation/send_test_error_button.dart': {
      'A test error, thrown on purpose from the developer tools',
    },
  };

  /// The routes' paths (design §3.6; P6 design §3.7), in the router and in the flow that names each
  /// state's route.
  static const Set<String> _routePaths = {
    '/history',
    '/settings',
    '/settings/my-station',
    '/settings/privacy',
    '/settings/about',
    '/r/:recognitionId',
    '/permission',
    '/listening',
    '/identifying',
    '/choose-station',
    '/result',
    '/no-match',
    '/busy',
    '/error',
    '/saved-offline',
  };

  /// The files that build widgets, where every animation lives: `app/`, `core/widgets/` and each
  /// feature's `presentation/`.
  static final RegExp _widgetCode = RegExp(r'^(?:app/|core/widgets/|features/\w+/presentation/)');

  /// The app's own words that look like a campaign button: the Error screen's support link
  /// (S4-D32), the only WhatsApp label the app writes itself, in the language files and as the
  /// never-shown label of the support chat's address.
  static const Map<String, Set<String>> allowedCampaignLikeLiterals = {
    'features/identify/domain/support_chat_address.dart': {'Message support on WhatsApp'},
    'l10n/app_localizations_en.dart': {'Message support on WhatsApp'},
  };

  /// A literal that is a campaign's own words (S4-RENDERER-01): a phone number (eight digits or
  /// more, spaced or not), a button label the shared card fixtures or the wireframes use, or text
  /// worded like a campaign button ("Call …", "Chat on …", "Visit …", anything with WhatsApp).
  static final RegExp campaignLiteralPattern = RegExp(
    r'(?<![\w.])\+?\d(?:[ \-]?\d){7,}(?![\w.])|'
    '^(?:${_campaignLabels().map(RegExp.escape).join('|')})\$|'
    r'^(?:Call|Chat|Visit|Find|Get directions|Book|Order|Shop|Buy)\b|WhatsApp',
  );

  /// The labels of every action in the shared card and answer fixtures, and the wireframes' own.
  static Set<String> _campaignLabels() {
    final labels = {'Call Brand A', 'Chat on WhatsApp', 'Get directions', 'Visit website'};
    void collect(Object? json) {
      if (json is Map<String, Object?>) {
        final label = json['label'];
        if (label is String && label.trim().length > 1) labels.add(label);
        json.values.forEach(collect);
      } else if (json is List<Object?>) {
        json.forEach(collect);
      }
    }

    for (final folder in [
      'action-card/valid',
      'action-card/invalid',
      'action-card/reader',
      'recognition/recognize-response/valid',
      'recognition/recognize-response/invalid',
    ]) {
      for (final fixture in ContractFixtures.readFolder(folder)) {
        collect(fixture.content);
      }
    }
    return labels;
  }

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
