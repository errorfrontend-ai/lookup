import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/settings/domain/data_saver_rule.dart';

/// The data saver's rule and "Used this month" in words' numbers (P6 design §2.11, §3.16).
void main() {
  test('pictures are held back only with the switch off on a metered network', () {
    expect(DataSaverRule.mayLoadPictures(isSwitchOn: true, isNetworkMetered: true), isTrue);
    expect(DataSaverRule.mayLoadPictures(isSwitchOn: true, isNetworkMetered: false), isTrue);
    expect(DataSaverRule.mayLoadPictures(isSwitchOn: false, isNetworkMetered: false), isTrue);
    expect(DataSaverRule.mayLoadPictures(isSwitchOn: false, isNetworkMetered: true), isFalse);
  });

  test('kilobytes of 1,000 bytes below a megabyte, then megabytes with one decimal', () {
    String shown(int bytes) => switch (DataAmount.of(bytes)) {
      DataAmountInKilobytes(:final kilobytes) => '$kilobytes KB',
      DataAmountInMegabytes(:final megabytes) => '$megabytes MB',
    };
    expect(shown(0), '0 KB');
    expect(shown(499), '0 KB');
    expect(shown(500), '1 KB');
    expect(shown(86497), '86 KB');
    expect(shown(999499), '999 KB');
    expect(shown(999500), '1.0 MB');
    expect(shown(1234567), '1.2 MB');
    expect(shown(15050000), '15.1 MB');
  });
}
