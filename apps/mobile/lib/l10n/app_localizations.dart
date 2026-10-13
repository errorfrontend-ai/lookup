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

  /// The button that stops listening, identifying or a busy wait and goes Home, or closes the station sheet without choosing.
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

  /// What screen readers announce for the tab bar at the bottom (or the rail at the side on a tablet): the app's main navigation.
  ///
  /// In en, this message translates to:
  /// **'Main'**
  String get mainNavigationLabel;

  /// The first tab: Home, where the listener identifies an ad.
  ///
  /// In en, this message translates to:
  /// **'Identify'**
  String get tabIdentify;

  /// The second tab: the results the listener identified before.
  ///
  /// In en, this message translates to:
  /// **'History'**
  String get tabHistory;

  /// The third tab: My station, the language, privacy and the app's details.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get tabSettings;

  /// The small button at the top right of Home that names the listener's station and opens Settings.
  ///
  /// In en, this message translates to:
  /// **'My station: {stationName}'**
  String homeMyStationChip(String stationName);

  /// The same small button on Home when the listener has not chosen a station.
  ///
  /// In en, this message translates to:
  /// **'My station: Not set'**
  String get homeMyStationChipNotSet;

  /// What screen readers add after the My station button on Home: where it leads.
  ///
  /// In en, this message translates to:
  /// **'Opens Settings'**
  String get homeMyStationChipHint;

  /// The heading of the short note Home shows the first time the app opens, and never again.
  ///
  /// In en, this message translates to:
  /// **'How Look Up works'**
  String get howItWorksTitle;

  /// The first sentence of the first-open note: what identifying does.
  ///
  /// In en, this message translates to:
  /// **'Tap Identify while an ad plays on the radio, and Look Up shows the advertiser\'s buttons: call, chat, directions or website.'**
  String get howItWorksIdentify;

  /// The second sentence of the first-open note: what History is for.
  ///
  /// In en, this message translates to:
  /// **'Ads you identify are saved in History, so their buttons work even without data.'**
  String get howItWorksHistory;

  /// The button that closes the first-open note.
  ///
  /// In en, this message translates to:
  /// **'Got it'**
  String get gotItButton;

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

  /// The heading of the sheet that asks which station the listener hears, when the ad is on more than one; also the sheet's name for screen readers.
  ///
  /// In en, this message translates to:
  /// **'Which station are you listening to?'**
  String get chooserTitle;

  /// Under the station sheet's heading, when at least one station shows the ad's own buttons.
  ///
  /// In en, this message translates to:
  /// **'This ad is on more than one station right now.'**
  String get chooserOnSeveralStationsNow;

  /// Under the station sheet's heading, when every station shows only the advertiser's usual buttons, so "right now" may not be true.
  ///
  /// In en, this message translates to:
  /// **'This ad is played on more than one station.'**
  String get chooserPlayedOnSeveralStations;

  /// Under a station's name in the station sheet: its frequency and its city, e.g. "98.1 FM · Lusaka". A station with no city shows its frequency alone.
  ///
  /// In en, this message translates to:
  /// **'{frequencyLabel} · {city}'**
  String chooserStationFrequencyAndCity(String frequencyLabel, String city);

  /// What screen readers announce for one station row of the station sheet, e.g. "Station A, 98.1 FM, Lusaka".
  ///
  /// In en, this message translates to:
  /// **'{stationName}, {frequencyLabel}, {city}'**
  String chooserStationSpokenWithCity(String stationName, String frequencyLabel, String city);

  /// What screen readers announce for one station row of the station sheet when the station has no city, e.g. "Station A, 98.1 FM".
  ///
  /// In en, this message translates to:
  /// **'{stationName}, {frequencyLabel}'**
  String chooserStationSpoken(String stationName, String frequencyLabel);

  /// The checkbox under the stations: when ticked, the chosen station becomes "My station" and later identifies of this kind skip the sheet.
  ///
  /// In en, this message translates to:
  /// **'Remember my station — skip this next time'**
  String get chooserRememberMyStation;

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

  /// Under the ad's title when the card is the advertiser's usual one rather than the campaign's: the ad may be out of its slots, or its campaign paused or at its limit.
  ///
  /// In en, this message translates to:
  /// **'These are {clientName}\'s usual contact details.'**
  String defaultCardNote(String clientName);

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

  /// Under a result's buttons, after a tick, once the result is kept on the phone.
  ///
  /// In en, this message translates to:
  /// **'Saved to History'**
  String get resultSavedToHistory;

  /// The heading beside the Back arrow when a result is opened again from History.
  ///
  /// In en, this message translates to:
  /// **'Saved result'**
  String get savedResultHeading;

  /// A short message when the result asked for is not in History any more.
  ///
  /// In en, this message translates to:
  /// **'That result is no longer saved on this phone.'**
  String get savedResultMissing;

  /// The heading of the History tab.
  ///
  /// In en, this message translates to:
  /// **'History'**
  String get historyHeading;

  /// The heading over the results identified before, newest first; drawn in capitals, read normally.
  ///
  /// In en, this message translates to:
  /// **'Earlier'**
  String get historyEarlierHeading;

  /// A History row's first line: the advertiser and the ad, e.g. "Brand A — Summer service offer".
  ///
  /// In en, this message translates to:
  /// **'{clientName} — {adTitle}'**
  String historyResultTitle(String clientName, String adTitle);

  /// A History row's second line: the station that played the ad and when the clip was recorded, e.g. "via Station A · Today, 09:12".
  ///
  /// In en, this message translates to:
  /// **'via {stationName} · {dayAndTime}'**
  String historyResultDetail(String stationName, String dayAndTime);

  /// A day and a time together, e.g. "Today, 09:12", "Yesterday, 18:40", "Mon, 07:55" or "3 Oct, 14:32".
  ///
  /// In en, this message translates to:
  /// **'{day}, {time}'**
  String dayAndTime(String day, String time);

  /// The day label for something that happened today, before its time.
  ///
  /// In en, this message translates to:
  /// **'Today'**
  String get dayToday;

  /// The day label for something that happened yesterday, before its time.
  ///
  /// In en, this message translates to:
  /// **'Yesterday'**
  String get dayYesterday;

  /// Under the list of saved results.
  ///
  /// In en, this message translates to:
  /// **'Saved results keep working without data — call, chat or get directions any time.'**
  String get historyOfflineNote;

  /// The heading of History before anything has been identified.
  ///
  /// In en, this message translates to:
  /// **'No results yet'**
  String get historyEmptyHeading;

  /// Under the heading of an empty History.
  ///
  /// In en, this message translates to:
  /// **'Ads you identify are saved here, so their buttons work even without data.'**
  String get historyEmptyExplanation;

  /// The heading of the Settings tab.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsHeading;

  /// The heading of the Settings section with My station; drawn in capitals, read normally.
  ///
  /// In en, this message translates to:
  /// **'Listening'**
  String get settingsListeningHeading;

  /// The Settings row that opens the station list, and the heading of that list.
  ///
  /// In en, this message translates to:
  /// **'My station'**
  String get settingsMyStation;

  /// Under "My station" in Settings when a station is chosen.
  ///
  /// In en, this message translates to:
  /// **'{stationName} · {frequencyLabel} — used when an ad is on more than one station'**
  String settingsMyStationChosen(String stationName, String frequencyLabel);

  /// Under "My station" in Settings when no station is chosen.
  ///
  /// In en, this message translates to:
  /// **'Not set — used when an ad is on more than one station'**
  String get settingsMyStationNotSet;

  /// The heading of the Settings section about the app itself; drawn in capitals, read normally.
  ///
  /// In en, this message translates to:
  /// **'App'**
  String get settingsAppHeading;

  /// The Settings row that names the app's language.
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get settingsLanguage;

  /// The name of this file's language, in that language, shown under "Language" in Settings.
  ///
  /// In en, this message translates to:
  /// **'English'**
  String get settingsLanguageName;

  /// The Settings row that opens the privacy summary, and that page's heading.
  ///
  /// In en, this message translates to:
  /// **'Privacy'**
  String get settingsPrivacy;

  /// The Settings row that opens the page about the app, and that page's heading.
  ///
  /// In en, this message translates to:
  /// **'About Look Up'**
  String get settingsAbout;

  /// The Settings row that deletes everything History keeps on the phone, after asking.
  ///
  /// In en, this message translates to:
  /// **'Clear history'**
  String get settingsClearHistory;

  /// The heading of the question asked before History is cleared.
  ///
  /// In en, this message translates to:
  /// **'Clear history?'**
  String get clearHistoryQuestion;

  /// What clearing History deletes, under the question.
  ///
  /// In en, this message translates to:
  /// **'Saved results and any clips waiting to be sent are deleted from this phone.'**
  String get clearHistoryExplanation;

  /// The button that clears History, in the question's footer.
  ///
  /// In en, this message translates to:
  /// **'Clear'**
  String get clearButton;

  /// The short confirmation after History was cleared.
  ///
  /// In en, this message translates to:
  /// **'History cleared'**
  String get historyClearedConfirmation;

  /// Under the heading of the My station list: what the choice is for.
  ///
  /// In en, this message translates to:
  /// **'Used when an ad is on more than one station.'**
  String get stationPickerLead;

  /// The label of the search field over a long station list.
  ///
  /// In en, this message translates to:
  /// **'Search stations'**
  String get stationPickerSearchLabel;

  /// The hint inside the station search field: what it matches.
  ///
  /// In en, this message translates to:
  /// **'Name, frequency or city'**
  String get stationPickerSearchHint;

  /// The first choice of the My station list: no station kept.
  ///
  /// In en, this message translates to:
  /// **'No station'**
  String get stationPickerNoStation;

  /// Under "No station": what happens when an ad is on more than one station.
  ///
  /// In en, this message translates to:
  /// **'Look Up will ask each time'**
  String get stationPickerNoStationDetail;

  /// Under the kept station at the top of the list when the station list no longer has it.
  ///
  /// In en, this message translates to:
  /// **'Not in the current list'**
  String get stationPickerNotListed;

  /// While the station list is fetched the first time.
  ///
  /// In en, this message translates to:
  /// **'Loading stations…'**
  String get stationPickerLoading;

  /// Over the station list when a newer list could not be fetched and the saved one is shown.
  ///
  /// In en, this message translates to:
  /// **'Couldn\'t refresh the list. These are the stations saved on {dayAndTime}.'**
  String stationPickerRefreshFailed(String dayAndTime);

  /// When no station list could be fetched and none is saved on the phone.
  ///
  /// In en, this message translates to:
  /// **'Couldn\'t load the stations.'**
  String get stationPickerLoadFailed;

  /// When the station list is empty.
  ///
  /// In en, this message translates to:
  /// **'No stations are listed in Look Up yet.'**
  String get stationPickerEmpty;

  /// The privacy summary's first point: when the app listens and for how long.
  ///
  /// In en, this message translates to:
  /// **'{seconds, plural, =1{Look Up listens only when you tap Identify, for about 1 second.} other{Look Up listens only when you tap Identify, for about {seconds} seconds.}}'**
  String privacyListensOnlyWhenYouTap(int seconds);

  /// The privacy summary's point on the recording.
  ///
  /// In en, this message translates to:
  /// **'The clip is sent to Look Up to find the ad, and is not kept after it has been checked.'**
  String get privacyClipNotKept;

  /// The privacy summary's point on History.
  ///
  /// In en, this message translates to:
  /// **'Your History stays on this phone. You can clear it in Settings.'**
  String get privacyHistoryStaysOnPhone;

  /// Under the privacy summary: it is not the full notice yet.
  ///
  /// In en, this message translates to:
  /// **'This is a short summary. The full privacy notice comes before Look Up\'s public release.'**
  String get privacySummaryNote;

  /// The app's version on the About page, e.g. "Version 0.1.0 (build 1)".
  ///
  /// In en, this message translates to:
  /// **'Version {version} (build {buildNumber})'**
  String aboutVersion(String version, String buildNumber);

  /// What the app does, on the About page.
  ///
  /// In en, this message translates to:
  /// **'Heard an ad on the radio? Tap Identify while it plays, and Look Up shows the advertiser\'s buttons: call, chat, directions or website.'**
  String get aboutDescription;

  /// The message typed into the support chat opened from the About page, which has no reference code.
  ///
  /// In en, this message translates to:
  /// **'Hello Look Up support.'**
  String get supportChatGreeting;

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

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_OUTBOX_SENDING_DELAY_MAXIMUM_SECONDS is not a whole number of seconds from 0 to 120.'**
  String get configurationProblemOutboxSendingDelayNotWholeSeconds;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_OUTBOX_SENDING_DELAY_MAXIMUM_SECONDS must be 120 outside the development flavour.'**
  String get configurationProblemOutboxSendingDelayOutsideDevelopment;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_OUTBOX_BACKOFF_FIRST_WAIT_SECONDS is not a whole number of seconds from 1 to 30.'**
  String get configurationProblemOutboxBackoffFirstWaitNotWholeSeconds;

  /// A build problem, listed only on the set-up screen of a development build; never seen by a listener.
  ///
  /// In en, this message translates to:
  /// **'LOOKUP_OUTBOX_BACKOFF_FIRST_WAIT_SECONDS must be 30 outside the development flavour.'**
  String get configurationProblemOutboxBackoffFirstWaitOutsideDevelopment;
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
