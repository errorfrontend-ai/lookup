// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'Look Up';

  @override
  String get closeButton => 'Close';

  @override
  String get cancelButton => 'Cancel';

  @override
  String get backButton => 'Back';

  @override
  String get backToHomeButton => 'Back to home';

  @override
  String get tryAgainButton => 'Try again';

  @override
  String get developmentOnlyDetails => 'Details (development only)';

  @override
  String get homeHeading => 'Heard an ad on the radio?';

  @override
  String get homeInstruction =>
      'Tap the button and hold your phone near the radio while the ad plays.';

  @override
  String homeDataNote(int seconds) {
    String _temp0 = intl.Intl.pluralLogic(
      seconds,
      locale: localeName,
      other: 'About $seconds seconds of listening · about 25 KB of data',
      one: 'About 1 second of listening · about 25 KB of data',
    );
    return '$_temp0';
  }

  @override
  String get identifyButtonLabel => 'Tap to identify';

  @override
  String get identifyButtonSpokenLabel => 'Identify the ad playing now';

  @override
  String get sendTestErrorButton => 'Send a test error';

  @override
  String get mainNavigationLabel => 'Main';

  @override
  String get tabIdentify => 'Identify';

  @override
  String get tabHistory => 'History';

  @override
  String get tabSettings => 'Settings';

  @override
  String homeMyStationChip(String stationName) {
    return 'My station: $stationName';
  }

  @override
  String get homeMyStationChipNotSet => 'My station: Not set';

  @override
  String get homeMyStationChipHint => 'Opens Settings';

  @override
  String get howItWorksTitle => 'How Look Up works';

  @override
  String get howItWorksIdentify =>
      'Tap Identify while an ad plays on the radio, and Look Up shows the advertiser\'s buttons: call, chat, directions or website.';

  @override
  String get howItWorksHistory =>
      'Ads you identify are saved in History, so their buttons work even without data.';

  @override
  String get gotItButton => 'Got it';

  @override
  String get permissionHeading => 'Look Up needs your microphone';

  @override
  String get permissionExplanation =>
      'We listen for a few seconds to recognise the ad on the radio. We don\'t keep the recording.';

  @override
  String get permissionPromiseOnlyWhenYouTap =>
      'Only when you tap Identify — never in the background.';

  @override
  String get permissionPromiseNeverWhoYouAre =>
      'Radio stations see how many people used their buttons — never who you are.';

  @override
  String get permissionRefusedOnceNote =>
      'You chose not to allow the microphone. Look Up can\'t identify an ad without it.';

  @override
  String get permissionRefusedForGoodNote =>
      'The microphone is turned off for Look Up. You can turn it on in your phone\'s settings.';

  @override
  String get allowMicrophoneButton => 'Allow microphone';

  @override
  String get openPhoneSettingsButton => 'Open phone settings';

  @override
  String get notNowButton => 'Not now';

  @override
  String get permissionSaidNoBefore => 'Said no before?';

  @override
  String get listeningHeading => 'Listening…';

  @override
  String get listeningInstruction => 'Keep your phone near the radio';

  @override
  String listeningSecondsLeft(int seconds) {
    String _temp0 = intl.Intl.pluralLogic(
      seconds,
      locale: localeName,
      other: '$seconds seconds left',
      one: '1 second left',
    );
    return '$_temp0';
  }

  @override
  String get cancelListeningLabel => 'Cancel listening';

  @override
  String get identifyingHeading => 'Identifying…';

  @override
  String get identifyingExplanation => 'This usually takes a few seconds.';

  @override
  String get cancelIdentifyingLabel => 'Cancel identifying';

  @override
  String get chooserTitle => 'Which station are you listening to?';

  @override
  String get chooserOnSeveralStationsNow => 'This ad is on more than one station right now.';

  @override
  String get chooserPlayedOnSeveralStations => 'This ad is played on more than one station.';

  @override
  String chooserStationFrequencyAndCity(String frequencyLabel, String city) {
    return '$frequencyLabel · $city';
  }

  @override
  String chooserStationSpokenWithCity(String stationName, String frequencyLabel, String city) {
    return '$stationName, $frequencyLabel, $city';
  }

  @override
  String chooserStationSpoken(String stationName, String frequencyLabel) {
    return '$stationName, $frequencyLabel';
  }

  @override
  String get chooserRememberMyStation => 'Remember my station — skip this next time';

  @override
  String get busyHeading => 'Lots of people are listening right now';

  @override
  String get busyExplanation =>
      'We kept your clip and will try again automatically. You don\'t need to record again.';

  @override
  String get busyCountdownLabel => 'Trying again in';

  @override
  String busyCountdown(int seconds) {
    return '$seconds s';
  }

  @override
  String busyCountdownSpoken(int seconds) {
    String _temp0 = intl.Intl.pluralLogic(
      seconds,
      locale: localeName,
      other: '$seconds seconds',
      one: '1 second',
    );
    return '$_temp0';
  }

  @override
  String get tryNowButton => 'Try now';

  @override
  String get noMatchHeading => 'We couldn\'t recognise that';

  @override
  String get noMatchExplanation =>
      'It may not be an ad we know yet, or it was too noisy to hear clearly.';

  @override
  String get noMatchTipsHeading => 'Try this';

  @override
  String get noMatchTipTurnUp => 'Turn the radio up, or move your phone closer.';

  @override
  String get noMatchTipTapDuringAd => 'Tap while the ad is playing — not during music or talk.';

  @override
  String get noMatchTipStepAway => 'Step away from traffic or other noise if you can.';

  @override
  String get errorSomethingWentWrongHeading => 'Something went wrong on our side';

  @override
  String get errorExplanationWithCode =>
      'Please try again. If it keeps happening, share this code with support so we can find the problem.';

  @override
  String get errorExplanationTryAgain => 'Please try again.';

  @override
  String get errorRecordingUnusableHeading => 'We couldn\'t use that recording';

  @override
  String get errorRecordingUnusableExplanation =>
      'Please try again, with your phone close to the radio.';

  @override
  String get errorNoConnectionHeading => 'No connection';

  @override
  String get errorNoConnectionExplanation =>
      'We couldn\'t reach Look Up. We kept your clip, so you can send it again when you have signal.';

  @override
  String get sendAgainButton => 'Send again';

  @override
  String get errorTooManyTriesHeading => 'Too many tries';

  @override
  String get errorTooManyTriesShortWaitExplanation =>
      'You\'ve identified a lot in a short time. Please wait a minute, then try again.';

  @override
  String get errorTooManyTriesLaterExplanation => 'Please try again later.';

  @override
  String get errorNewerAppHeading => 'This needs a newer Look Up';

  @override
  String get errorNewerAppUnknownAnswerExplanation =>
      'We found an answer this version of the app can\'t show yet.';

  @override
  String get referenceCodeLabel => 'Reference code';

  @override
  String get copyButton => 'Copy';

  @override
  String get codeCopiedConfirmation => 'Code copied';

  @override
  String get supportChatButton => 'Message support on WhatsApp';

  @override
  String supportChatMessage(String referenceCode) {
    return 'Hello Look Up support, my reference code is $referenceCode.';
  }

  @override
  String get resultFoundIt => 'Found it';

  @override
  String resultViaStation(String stationName, String frequencyLabel) {
    return 'via $stationName · $frequencyLabel';
  }

  @override
  String defaultCardNote(String clientName) {
    return 'These are $clientName\'s usual contact details.';
  }

  @override
  String get resultUpdateAppHint => 'Some buttons need a newer version of Look Up.';

  @override
  String get resultNoButtons => 'This ad has no buttons right now.';

  @override
  String get moreOptionsButton => 'More options';

  @override
  String get resultSavedToHistory => 'Saved to History';

  @override
  String get savedResultHeading => 'Saved result';

  @override
  String get savedResultMissing => 'That result is no longer saved on this phone.';

  @override
  String get historyHeading => 'History';

  @override
  String get historyEarlierHeading => 'Earlier';

  @override
  String historyResultTitle(String clientName, String adTitle) {
    return '$clientName — $adTitle';
  }

  @override
  String historyResultDetail(String stationName, String dayAndTime) {
    return 'via $stationName · $dayAndTime';
  }

  @override
  String dayAndTime(String day, String time) {
    return '$day, $time';
  }

  @override
  String get dayToday => 'Today';

  @override
  String get dayYesterday => 'Yesterday';

  @override
  String get historyOfflineNote =>
      'Saved results keep working without data — call, chat or get directions any time.';

  @override
  String get historyEmptyHeading => 'No results yet';

  @override
  String get historyEmptyExplanation =>
      'Ads you identify are saved here, so their buttons work even without data.';

  @override
  String get settingsHeading => 'Settings';

  @override
  String get settingsListeningHeading => 'Listening';

  @override
  String get settingsMyStation => 'My station';

  @override
  String settingsMyStationChosen(String stationName, String frequencyLabel) {
    return '$stationName · $frequencyLabel — used when an ad is on more than one station';
  }

  @override
  String get settingsMyStationNotSet => 'Not set — used when an ad is on more than one station';

  @override
  String get settingsAppHeading => 'App';

  @override
  String get settingsLanguage => 'Language';

  @override
  String get settingsLanguageName => 'English';

  @override
  String get settingsPrivacy => 'Privacy';

  @override
  String get settingsAbout => 'About Look Up';

  @override
  String get settingsClearHistory => 'Clear history';

  @override
  String get clearHistoryQuestion => 'Clear history?';

  @override
  String get clearHistoryExplanation =>
      'Saved results and any clips waiting to be sent are deleted from this phone.';

  @override
  String get clearButton => 'Clear';

  @override
  String get historyClearedConfirmation => 'History cleared';

  @override
  String get stationPickerLead => 'Used when an ad is on more than one station.';

  @override
  String get stationPickerSearchLabel => 'Search stations';

  @override
  String get stationPickerSearchHint => 'Name, frequency or city';

  @override
  String get stationPickerNoStation => 'No station';

  @override
  String get stationPickerNoStationDetail => 'Look Up will ask each time';

  @override
  String get stationPickerNotListed => 'Not in the current list';

  @override
  String get stationPickerLoading => 'Loading stations…';

  @override
  String stationPickerRefreshFailed(String dayAndTime) {
    return 'Couldn\'t refresh the list. These are the stations saved on $dayAndTime.';
  }

  @override
  String get stationPickerLoadFailed => 'Couldn\'t load the stations.';

  @override
  String get stationPickerEmpty => 'No stations are listed in Look Up yet.';

  @override
  String privacyListensOnlyWhenYouTap(int seconds) {
    String _temp0 = intl.Intl.pluralLogic(
      seconds,
      locale: localeName,
      other: 'Look Up listens only when you tap Identify, for about $seconds seconds.',
      one: 'Look Up listens only when you tap Identify, for about 1 second.',
    );
    return '$_temp0';
  }

  @override
  String get privacyClipNotKept =>
      'The clip is sent to Look Up to find the ad, and is not kept after it has been checked.';

  @override
  String get privacyHistoryStaysOnPhone =>
      'Your History stays on this phone. You can clear it in Settings.';

  @override
  String get privacySummaryNote =>
      'This is a short summary. The full privacy notice comes before Look Up\'s public release.';

  @override
  String aboutVersion(String version, String buildNumber) {
    return 'Version $version (build $buildNumber)';
  }

  @override
  String get aboutDescription =>
      'Heard an ad on the radio? Tap Identify while it plays, and Look Up shows the advertiser\'s buttons: call, chat, directions or website.';

  @override
  String get supportChatGreeting => 'Hello Look Up support.';

  @override
  String get launchFailureHeading => 'Couldn\'t open this';

  @override
  String get launchFailureNumberExplanation =>
      'Your phone couldn\'t open it. You can copy the number instead.';

  @override
  String get launchFailureLinkExplanation =>
      'Your phone couldn\'t open it. You can copy the link instead.';

  @override
  String get copyNumberButton => 'Copy number';

  @override
  String get copyLinkButton => 'Copy link';

  @override
  String get numberCopiedConfirmation => 'Number copied';

  @override
  String get linkCopiedConfirmation => 'Link copied';

  @override
  String get plainErrorFallbackMessage => 'This part couldn\'t be shown.';

  @override
  String get setUpProblemHeading => 'This copy of Look Up isn\'t set up correctly.';

  @override
  String get configurationProblemFlavourNotRecognised =>
      'LOOKUP_FLAVOUR is missing or is not development, staging or production.';

  @override
  String get configurationProblemGradleFlavourDiffers =>
      'The Android build flavour (--flavor) is not the one LOOKUP_FLAVOUR names.';

  @override
  String get configurationProblemApiBaseUrlMissing => 'LOOKUP_API_BASE_URL is missing.';

  @override
  String get configurationProblemApiBaseUrlMalformed =>
      'LOOKUP_API_BASE_URL is not a plain http or https address with a host (no spaces, user name, query or fragment).';

  @override
  String get configurationProblemApiBaseUrlNotEndingApiVersion1 =>
      'LOOKUP_API_BASE_URL does not end with /api/v1.';

  @override
  String get configurationProblemApiBaseUrlNotHttps =>
      'LOOKUP_API_BASE_URL must use https outside the development flavour.';

  @override
  String get configurationProblemErrorDetailsFlagNotTrueOrFalse =>
      'LOOKUP_SHOW_ERROR_DETAILS is neither true nor false.';

  @override
  String get configurationProblemErrorDetailsOutsideDevelopment =>
      'LOOKUP_SHOW_ERROR_DETAILS is on outside the development flavour.';

  @override
  String get configurationProblemDeveloperToolsFlagNotTrueOrFalse =>
      'LOOKUP_SHOW_DEVELOPER_TOOLS is neither true nor false.';

  @override
  String get configurationProblemDeveloperToolsOutsideDevelopment =>
      'LOOKUP_SHOW_DEVELOPER_TOOLS is on outside the development flavour.';

  @override
  String get configurationProblemVerboseLogsFlagNotTrueOrFalse =>
      'LOOKUP_VERBOSE_LOGS is neither true nor false.';

  @override
  String get configurationProblemVerboseLogsOutsideDevelopment =>
      'LOOKUP_VERBOSE_LOGS is on outside the development flavour.';

  @override
  String get configurationProblemSupportWhatsAppNumberMissing =>
      'LOOKUP_SUPPORT_WHATSAPP_NUMBER is missing; staging and production builds must have it.';

  @override
  String get configurationProblemSupportWhatsAppNumberNotE164 =>
      'LOOKUP_SUPPORT_WHATSAPP_NUMBER is not an E.164 number such as +260971234567.';

  @override
  String get configurationProblemOutboxSendingDelayNotWholeSeconds =>
      'LOOKUP_OUTBOX_SENDING_DELAY_MAXIMUM_SECONDS is not a whole number of seconds from 0 to 120.';

  @override
  String get configurationProblemOutboxSendingDelayOutsideDevelopment =>
      'LOOKUP_OUTBOX_SENDING_DELAY_MAXIMUM_SECONDS must be 120 outside the development flavour.';

  @override
  String get configurationProblemOutboxBackoffFirstWaitNotWholeSeconds =>
      'LOOKUP_OUTBOX_BACKOFF_FIRST_WAIT_SECONDS is not a whole number of seconds from 1 to 30.';

  @override
  String get configurationProblemOutboxBackoffFirstWaitOutsideDevelopment =>
      'LOOKUP_OUTBOX_BACKOFF_FIRST_WAIT_SECONDS must be 30 outside the development flavour.';

  @override
  String get okButton => 'OK';

  @override
  String get savedClipNotificationTitle => 'Look Up';

  @override
  String get savedClipNotificationText =>
      'Your saved clip has been checked. Tap to see the result.';

  @override
  String get savedClipNotificationChannelName => 'Saved clip results';

  @override
  String get savedClipNotificationChannelDescription =>
      'When a clip saved with no signal has been checked';

  @override
  String get savedOfflineHeadingNoConnection =>
      'Saved — we\'ll identify it when you\'re back online';

  @override
  String get savedOfflineBodyNoConnection =>
      'No signal right now. Your clip stays on this phone for up to 24 hours and is deleted as soon as it\'s sent.';

  @override
  String get savedOfflineHeadingBusy => 'Saved — we\'ll identify it when Look Up is less busy';

  @override
  String get savedOfflineBodyBusy =>
      'Lots of people are listening right now. Your clip stays on this phone for up to 24 hours and is deleted as soon as it\'s sent.';

  @override
  String get savedOfflineHeadingTooManyTries => 'Saved — we\'ll identify it a little later';

  @override
  String get savedOfflineBodyTooManyTries =>
      'You\'ve identified a lot in a short time. Your clip stays on this phone for up to 24 hours and is deleted as soon as it\'s sent.';

  @override
  String get savedOfflineOldestClipDeleted =>
      'You had 5 clips waiting, so the oldest one was deleted.';

  @override
  String get savedOfflineNotificationsAllowed =>
      'You\'ll get a notification with the result, including the station\'s buttons.';

  @override
  String get savedOfflineNotificationsNotAsked =>
      'Allow notifications to hear when the result is ready.';

  @override
  String get savedOfflineAllowNotificationsButton => 'Allow notifications';

  @override
  String get savedOfflineNotificationsOff =>
      'Notifications are off for Look Up, so the result will wait in History.';

  @override
  String get savedOfflineSeeInHistoryButton => 'See it in History';

  @override
  String get historyWaitingHeading => 'Waiting for signal';

  @override
  String historyClipFrom(String dayAndTime) {
    return 'Clip from $dayAndTime';
  }

  @override
  String get dayTodayInSentence => 'today';

  @override
  String get dayYesterdayInSentence => 'yesterday';

  @override
  String get historyWaitingForSignal => 'Will identify when you\'re back online';

  @override
  String get historyWaitingBusy => 'Look Up is busy — will try again soon';

  @override
  String get historyWaitingForUpdate => 'Waiting for a newer version of Look Up';

  @override
  String get historyPendingBadge => 'Pending';

  @override
  String get historyAwaitingChoiceDetail => 'Choose your station to see the buttons';

  @override
  String get historyNotRecognised => 'Not recognised';

  @override
  String get historyNotSentWithin24Hours => 'Not sent within 24 hours — deleted';

  @override
  String get historyCouldNotBeChecked => 'Couldn\'t be checked — deleted';

  @override
  String get permissionPromiseOfflineClip =>
      'No signal? The clip waits on your phone and is deleted once it\'s sent — never kept longer than 24 hours.';

  @override
  String get errorPleaseUpdateHeading => 'Please update the app';

  @override
  String get errorPleaseUpdateExplanation => 'This version of Look Up is too old to identify ads.';
}
