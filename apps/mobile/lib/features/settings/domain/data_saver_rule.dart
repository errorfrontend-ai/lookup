/// "Load ad pictures on mobile data" (P6 design §3.16; P6-DATASAVER-04 to -06): pictures are left
/// out only when the switch is off and the network is metered. "Mobile data" means a metered
/// network, so a phone's hotspot counts too, which is the point.
abstract final class DataSaverRule {
  static bool mayLoadPictures({required bool isSwitchOn, required bool isNetworkMetered}) =>
      isSwitchOn || !isNetworkMetered;
}

/// "Used this month" in words' numbers (P6 design §2.11; Q11): kilobytes of 1,000 bytes below a
/// megabyte, then megabytes with one decimal ("86 KB", "1.2 MB").
sealed class DataAmount {
  const DataAmount();

  static DataAmount of(int bytes) {
    final kilobytes = (bytes / 1000).round();
    if (kilobytes < 1000) return DataAmountInKilobytes(kilobytes);
    return DataAmountInMegabytes((bytes / 1000000).toStringAsFixed(1));
  }
}

final class DataAmountInKilobytes extends DataAmount {
  const DataAmountInKilobytes(this.kilobytes);

  final int kilobytes;
}

final class DataAmountInMegabytes extends DataAmount {
  const DataAmountInMegabytes(this.megabytes);

  /// With one decimal, e.g. `1.2`.
  final String megabytes;
}
