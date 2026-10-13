import 'package:lookup_listener/features/result/domain/read_action_card.dart';

/// Why this card is shown. The Result screen adds a note for [clientDefault] (S4-D21; P6 design
/// §2.7, amendment A7).
enum RecognitionResultKind {
  /// The ad was on air when it was heard: the campaign's own card.
  campaign,

  /// The advertiser's usual card, shown instead of the campaign's. The answer does not say why: the
  /// ad was out of its slots, or its campaign was paused after the clip was heard or reached its tap
  /// limit (P6-D42).
  clientDefault,
}

/// An image the phone may download, with its size known before it arrives, so the screen can keep
/// its space and nothing moves when it loads.
final class PublicImage {
  const PublicImage({
    required this.address,
    required this.widthPixels,
    required this.heightPixels,
    required this.sizeBytes,
  });

  /// Always https: the answer's reader leaves out an image with any other address (S4-D15).
  final String address;
  final int widthPixels;
  final int heightPixels;
  final int sizeBytes;
}

/// What the Result screen shows after a match, or what one row of "Which station?" offers: which
/// station played the ad, whose ad it was, its title, and the station's buttons. Plain data, filled
/// by the recognize answer's reader; nothing internal (no match scores, campaign or audio ids) is
/// ever kept here, so nothing internal can be shown.
final class RecognitionResult {
  const RecognitionResult({
    required this.recognitionId,
    required this.kind,
    required this.stationId,
    required this.stationName,
    required this.stationFrequencyLabel,
    required this.clientName,
    required this.title,
    required this.card,
    this.stationCity,
    this.stationLogo,
    this.clientLogo,
    this.headerImage,
  });

  /// The recognition this result answers: a lower-case UUID version 7, from the answer. The station
  /// choice, and later History, button taps and reports, name it (P6 design §3.4).
  final String recognitionId;

  final RecognitionResultKind kind;

  /// The station's one public reference (S3-RESPONSE-17): the hint, the choice and taps use it.
  final String stationId;

  /// E.g. "Station A".
  final String stationName;

  /// E.g. "98.1 FM".
  final String stationFrequencyLabel;

  /// E.g. "Lusaka"; null when the station has none (contract §2.1, P6-CHOOSER-03).
  final String? stationCity;

  /// The advertiser, e.g. "Brand A".
  final String clientName;

  /// The ad's title, the screen's main heading.
  final String title;

  /// The buttons, as the tolerant reader read them.
  final ReadActionCard card;

  final PublicImage? stationLogo;

  /// Shown in the round logo; without it the screen shows the client name's first letter.
  final PublicImage? clientLogo;

  /// The 2:1 banner above the card; without it the screen draws no banner box at all (S4-D20).
  final PublicImage? headerImage;
}
