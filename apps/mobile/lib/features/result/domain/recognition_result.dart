import 'package:lookup_listener/features/result/domain/read_action_card.dart';

/// Why this card is shown. The Result screen adds a note for [clientDefault] (S4-D21).
enum RecognitionResultKind {
  /// The ad was on air when it was heard: the campaign's own card.
  campaign,

  /// The ad was not on air then, so the advertiser's usual card is shown instead.
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

/// What the Result screen shows after a match: which station played the ad, whose ad it was, its
/// title, and the station's buttons. Plain data, filled by the recognize answer's reader; nothing
/// internal (no match scores, campaign or audio ids) is ever kept here, so nothing internal can be shown.
final class RecognitionResult {
  const RecognitionResult({
    required this.kind,
    required this.stationId,
    required this.stationName,
    required this.stationFrequencyLabel,
    required this.clientName,
    required this.title,
    required this.card,
    this.stationLogo,
    this.clientLogo,
    this.headerImage,
  });

  final RecognitionResultKind kind;

  /// The station's one public reference.
  final String stationId;

  /// E.g. "Station A".
  final String stationName;

  /// E.g. "98.1 FM".
  final String stationFrequencyLabel;

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
