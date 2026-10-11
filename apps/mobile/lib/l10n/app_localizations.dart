import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale) : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate = _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[Locale('en')];

  /// The app's name: Home's title and the name in the phone's list of recent apps.
  ///
  /// In en, this message translates to:
  /// **'Look Up'**
  String get appTitle;

  /// A Close button, or what screen readers announce for the Close ×: ends what is under way or closes a sheet.
  ///
  /// In en, this message translates to:
  /// **'Close'**
  String get closeButton;

  /// The button that stops listening, identifying or a busy wait and goes Home.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancelButton;

  /// What screen readers announce for the Back arrow on the microphone screen.
  ///
  /// In en, this message translates to:
  /// **'Back'**
  String get backButton;

  /// The button, and the Back arrow's spoken label, that goes to Home.
  ///
  /// In en, this message translates to:
  /// **'Back to home'**
  String get backToHomeButton;

  /// The button that starts a new listening after a failure or no match.
  ///
  /// In en, this message translates to:
  /// **'Try again'**
  String get tryAgainButton;

  /// The heading of technical details shown only in a development build of the app; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'Details (development only)'**
  String get developmentOnlyDetails;

  /// Home's main question, over the identify button.
  ///
  /// In en, this message translates to:
  /// **'Heard an ad on the radio?'**
  String get homeHeading;

  /// How identifying works, under the question on Home.
  ///
  /// In en, this message translates to:
  /// **'Tap the button and hold your phone near the radio while the ad plays.'**
  String get homeInstruction;

  /// What one identify costs, under the identify button: how long the app listens and how much mobile data the upload uses.
  ///
  /// In en, this message translates to:
  /// **'{seconds, plural, =1{About 1 second of listening · about 25 KB of data} other{About {seconds} seconds of listening · about 25 KB of data}}'**
  String homeDataNote(int seconds);

  /// The words drawn on the big round identify button on Home.
  ///
  /// In en, this message translates to:
  /// **'Tap to identify'**
  String get identifyButtonLabel;

  /// What screen readers announce for the big round identify button.
  ///
  /// In en, this message translates to:
  /// **'Identify the ad playing now'**
  String get identifyButtonSpokenLabel;

  /// A development-only button on Home that throws a test error on purpose; never in a listener's build.
  ///
  /// In en, this message translates to:
  /// **'Send a test error'**
  String get sendTestErrorButton;

  /// The heading of the screen that asks for the microphone.
  ///
  /// In en, this message translates to:
  /// **'Look Up needs your microphone'**
  String get permissionHeading;

  /// Why the app needs the microphone.
  ///
  /// In en, this message translates to:
  /// **'We listen for a few seconds to recognise the ad on the radio. We don\'t keep the recording.'**
  String get permissionExplanation;

  /// The first promise, after a tick: when the app listens.
  ///
  /// In en, this message translates to:
  /// **'Only when you tap Identify — never in the background.'**
  String get permissionPromiseOnlyWhenYouTap;

  /// The second promise, after a tick: what stations learn.
  ///
  /// In en, this message translates to:
  /// **'Radio stations see how many people used their buttons — never who you are.'**
  String get permissionPromiseNeverWhoYouAre;

  /// Shown after the listener refused the microphone once.
  ///
  /// In en, this message translates to:
  /// **'You chose not to allow the microphone. Look Up can\'t identify an ad without it.'**
  String get permissionRefusedOnceNote;

  /// Shown when the phone will not ask for the microphone again.
  ///
  /// In en, this message translates to:
  /// **'The microphone is turned off for Look Up. You can turn it on in your phone\'s settings.'**
  String get permissionRefusedForGoodNote;

  /// The main button, which opens the phone's own microphone prompt.
  ///
  /// In en, this message translates to:
  /// **'Allow microphone'**
  String get allowMicrophoneButton;

  /// The button that opens the app's page in the phone's settings.
  ///
  /// In en, this message translates to:
  /// **'Open phone settings'**
  String get openPhoneSettingsButton;

  /// The button that leaves the microphone screen without asking.
  ///
  /// In en, this message translates to:
  /// **'Not now'**
  String get notNowButton;

  /// The words before the small "Open phone settings" button under the main buttons.
  ///
  /// In en, this message translates to:
  /// **'Said no before?'**
  String get permissionSaidNoBefore;

  /// The heading while the app records the clip.
  ///
  /// In en, this message translates to:
  /// **'Listening…'**
  String get listeningHeading;

  /// The instruction while the app records the clip.
  ///
  /// In en, this message translates to:
  /// **'Keep your phone near the radio'**
  String get listeningInstruction;

  /// The countdown while recording, e.g. "8 seconds left".
  ///
  /// In en, this message translates to:
  /// **'{seconds, plural, =1{1 second left} other{{seconds} seconds left}}'**
  String listeningSecondsLeft(int seconds);

  /// What screen readers announce for the Close × while recording.
  ///
  /// In en, this message translates to:
  /// **'Cancel listening'**
  String get cancelListeningLabel;

  /// The heading while the clip is sent and checked.
  ///
  /// In en, this message translates to:
  /// **'Identifying…'**
  String get identifyingHeading;

  /// Under the heading while the clip is sent and checked.
  ///
  /// In en, this message translates to:
  /// **'This usually takes a few seconds.'**
  String get identifyingExplanation;

  /// What screen readers announce for the Close × while identifying.
  ///
  /// In en, this message translates to:
  /// **'Cancel identifying'**
  String get cancelIdentifyingLabel;

  /// The heading when the service had no room and the app will send the clip again by itself.
  ///
  /// In en, this message translates to:
  /// **'Lots of people are listening right now'**
  String get busyHeading;

  /// Under the busy heading.
  ///
  /// In en, this message translates to:
  /// **'We kept your clip and will try again automatically. You don\'t need to record again.'**
  String get busyExplanation;

  /// The words before the countdown to the next automatic send.
  ///
  /// In en, this message translates to:
  /// **'Trying again in'**
  String get busyCountdownLabel;

  /// The countdown to the next automatic send as drawn, e.g. "12 s".
  ///
  /// In en, this message translates to:
  /// **'{seconds} s'**
  String busyCountdown(int seconds);

  /// The countdown as screen readers say it, e.g. "12 seconds".
  ///
  /// In en, this message translates to:
  /// **'{seconds, plural, =1{1 second} other{{seconds} seconds}}'**
  String busyCountdownSpoken(int seconds);

  /// The button that sends the kept clip at once instead of waiting.
  ///
  /// In en, this message translates to:
  /// **'Try now'**
  String get tryNowButton;

  /// The heading when the clip was heard but not recognised.
  ///
  /// In en, this message translates to:
  /// **'We couldn\'t recognise that'**
  String get noMatchHeading;

  /// Under the no-match heading.
  ///
  /// In en, this message translates to:
  /// **'It may not be an ad we know yet, or it was too noisy to hear clearly.'**
  String get noMatchExplanation;

  /// The heading of the numbered tips.
  ///
  /// In en, this message translates to:
  /// **'Try this'**
  String get noMatchTipsHeading;

  /// The first numbered tip.
  ///
  /// In en, this message translates to:
  /// **'Turn the radio up, or move your phone closer.'**
  String get noMatchTipTurnUp;

  /// The second numbered tip.
  ///
  /// In en, this message translates to:
  /// **'Tap while the ad is playing — not during music or talk.'**
  String get noMatchTipTapDuringAd;

  /// The third numbered tip.
  ///
  /// In en, this message translates to:
  /// **'Step away from traffic or other noise if you can.'**
  String get noMatchTipStepAway;

  /// The heading of a failure on the server or on the phone.
  ///
  /// In en, this message translates to:
  /// **'Something went wrong on our side'**
  String get errorSomethingWentWrongHeading;

  /// Under the failure heading when a reference code is shown.
  ///
  /// In en, this message translates to:
  /// **'Please try again. If it keeps happening, share this code with support so we can find the problem.'**
  String get errorExplanationWithCode;

  /// Under the failure heading when no reference code can be shown yet.
  ///
  /// In en, this message translates to:
  /// **'Please try again.'**
  String get errorExplanationTryAgain;

  /// The heading when the service could not use the clip.
  ///
  /// In en, this message translates to:
  /// **'We couldn\'t use that recording'**
  String get errorRecordingUnusableHeading;

  /// Under the unusable-recording heading.
  ///
  /// In en, this message translates to:
  /// **'Please try again, with your phone close to the radio.'**
  String get errorRecordingUnusableExplanation;

  /// The heading when no answer came over the network.
  ///
  /// In en, this message translates to:
  /// **'No connection'**
  String get errorNoConnectionHeading;

  /// Under the no-connection heading.
  ///
  /// In en, this message translates to:
  /// **'We couldn\'t reach Look Up. We kept your clip, so you can send it again when you have signal.'**
  String get errorNoConnectionExplanation;

  /// The button that sends the kept clip again after no connection.
  ///
  /// In en, this message translates to:
  /// **'Send again'**
  String get sendAgainButton;

  /// The heading when the listener identified too often.
  ///
  /// In en, this message translates to:
  /// **'Too many tries'**
  String get errorTooManyTriesHeading;

  /// Under the too-many-tries heading when the wait is a minute or less.
  ///
  /// In en, this message translates to:
  /// **'You\'ve identified a lot in a short time. Please wait a minute, then try again.'**
  String get errorTooManyTriesShortWaitExplanation;

  /// Under the too-many-tries heading when the wait is longer.
  ///
  /// In en, this message translates to:
  /// **'Please try again later.'**
  String get errorTooManyTriesLaterExplanation;

  /// The heading when the answer is one this version of the app cannot show.
  ///
  /// In en, this message translates to:
  /// **'This needs a newer Look Up'**
  String get errorNewerAppHeading;

  /// Under the newer-app heading when the ad is on several stations.
  ///
  /// In en, this message translates to:
  /// **'This ad is on more than one station, and this version of the app can\'t show that yet.'**
  String get errorNewerAppSeveralStationsExplanation;

  /// Under the newer-app heading for any other answer it cannot show.
  ///
  /// In en, this message translates to:
  /// **'We found an answer this version of the app can\'t show yet.'**
  String get errorNewerAppUnknownAnswerExplanation;

  /// The label over the code the listener can share with support, e.g. "6F1C-2D3E".
  ///
  /// In en, this message translates to:
  /// **'Reference code'**
  String get referenceCodeLabel;

  /// The button that copies the reference code.
  ///
  /// In en, this message translates to:
  /// **'Copy'**
  String get copyButton;

  /// The short confirmation after the reference code was copied.
  ///
  /// In en, this message translates to:
  /// **'Code copied'**
  String get codeCopiedConfirmation;

  /// The button under the reference code that opens a WhatsApp chat with Look Up support.
  ///
  /// In en, this message translates to:
  /// **'Message support on WhatsApp'**
  String get supportChatButton;

  /// The message typed into the support chat, so the listener only has to press send.
  ///
  /// In en, this message translates to:
  /// **'Hello Look Up support, my reference code is {referenceCode}.'**
  String supportChatMessage(String referenceCode);

  /// The heading beside the Back arrow when the ad was recognised.
  ///
  /// In en, this message translates to:
  /// **'Found it'**
  String get resultFoundIt;

  /// Under the advertiser: the station that played the ad.
  ///
  /// In en, this message translates to:
  /// **'via {stationName} · {frequencyLabel}'**
  String resultViaStation(String stationName, String frequencyLabel);

  /// Under the ad's title when the card is the advertiser's usual one rather than the campaign's.
  ///
  /// In en, this message translates to:
  /// **'This ad isn\'t on air right now, so these are {clientName}\'s usual contact details.'**
  String resultClientDefaultNote(String clientName);

  /// Under the title when some buttons are of a kind this version cannot show.
  ///
  /// In en, this message translates to:
  /// **'Some buttons need a newer version of Look Up.'**
  String get resultUpdateAppHint;

  /// Under the title when the card has no button the app can show.
  ///
  /// In en, this message translates to:
  /// **'This ad has no buttons right now.'**
  String get resultNoButtons;

  /// The button under the fourth button that shows the rest.
  ///
  /// In en, this message translates to:
  /// **'More options'**
  String get moreOptionsButton;

  /// The heading of the sheet shown when the phone could not open a button's address.
  ///
  /// In en, this message translates to:
  /// **'Couldn\'t open this'**
  String get launchFailureHeading;

  /// On the sheet, for a call or WhatsApp button.
  ///
  /// In en, this message translates to:
  /// **'Your phone couldn\'t open it. You can copy the number instead.'**
  String get launchFailureNumberExplanation;

  /// On the sheet, for a map or link button.
  ///
  /// In en, this message translates to:
  /// **'Your phone couldn\'t open it. You can copy the link instead.'**
  String get launchFailureLinkExplanation;

  /// The button that copies the phone number.
  ///
  /// In en, this message translates to:
  /// **'Copy number'**
  String get copyNumberButton;

  /// The button that copies the link.
  ///
  /// In en, this message translates to:
  /// **'Copy link'**
  String get copyLinkButton;

  /// The short confirmation after the number was copied.
  ///
  /// In en, this message translates to:
  /// **'Number copied'**
  String get numberCopiedConfirmation;

  /// The short confirmation after the link was copied.
  ///
  /// In en, this message translates to:
  /// **'Link copied'**
  String get linkCopiedConfirmation;

  /// Shown in place of a part of a screen that failed to draw.
  ///
  /// In en, this message translates to:
  /// **'This part couldn\'t be shown.'**
  String get plainErrorFallbackMessage;

  /// The only words a wrongly built copy of the app shows.
  ///
  /// In en, this message translates to:
  /// **'This copy of Look Up isn\'t set up correctly.'**
  String get setUpProblemHeading;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_FLAVOUR is missing or is not development, staging or production.'**
  String get configurationProblemFlavourNotRecognised;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'The Android build flavour (--flavor) is not the one LOOKUP_FLAVOUR names.'**
  String get configurationProblemGradleFlavourDiffers;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_API_BASE_URL is missing.'**
  String get configurationProblemApiBaseUrlMissing;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_API_BASE_URL is not a plain http or https address with a host (no spaces, user name, query or fragment).'**
  String get configurationProblemApiBaseUrlMalformed;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_API_BASE_URL does not end with /api/v1.'**
  String get configurationProblemApiBaseUrlNotEndingApiVersion1;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_API_BASE_URL must use https outside the development flavour.'**
  String get configurationProblemApiBaseUrlNotHttps;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_SHOW_ERROR_DETAILS is neither true nor false.'**
  String get configurationProblemErrorDetailsFlagNotTrueOrFalse;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_SHOW_ERROR_DETAILS is on outside the development flavour.'**
  String get configurationProblemErrorDetailsOutsideDevelopment;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_SHOW_DEVELOPER_TOOLS is neither true nor false.'**
  String get configurationProblemDeveloperToolsFlagNotTrueOrFalse;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_SHOW_DEVELOPER_TOOLS is on outside the development flavour.'**
  String get configurationProblemDeveloperToolsOutsideDevelopment;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_VERBOSE_LOGS is neither true nor false.'**
  String get configurationProblemVerboseLogsFlagNotTrueOrFalse;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_VERBOSE_LOGS is on outside the development flavour.'**
  String get configurationProblemVerboseLogsOutsideDevelopment;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_SUPPORT_WHATSAPP_NUMBER is missing; staging and production builds must have it.'**
  String get configurationProblemSupportWhatsAppNumberMissing;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_SUPPORT_WHATSAPP_NUMBER is not an E.164 number such as +260971234567.'**
  String get configurationProblemSupportWhatsAppNumberNotE164;
}

class _AppLocalizationsDelegate extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) => <String>['en'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
