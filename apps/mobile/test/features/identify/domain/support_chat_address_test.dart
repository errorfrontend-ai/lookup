import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/support_chat_address.dart';
import 'package:lookup_listener/features/result/domain/action_uri_builder.dart';

void main() {
  test('the message carries the code, word for word (S4-D32)', () {
    expect(
      supportChatMessage('6F1C-2D3E'),
      'Hello Look Up support, my reference code is 6F1C-2D3E.',
    );
  });

  test('the address is a wa.me chat with the message encoded as encodeURIComponent does', () {
    expect(
      buildSupportChatAddress(supportWhatsAppNumber: '+260971234567', referenceCode: '6F1C-2D3E'),
      'https://wa.me/260971234567?text=Hello%20Look%20Up%20support%2C%20my%20reference%20code%20is'
      '%206F1C-2D3E.',
    );
  });

  test('it only ever starts with the WhatsApp prefix the card buttons use', () {
    final address = buildSupportChatAddress(
      supportWhatsAppNumber: '+447700900123',
      referenceCode: '0A1B-2C3D',
    );
    expect(address, startsWith(whatsAppAddressPrefix));
  });

  test('a number the card builder would refuse gives no address', () {
    for (final number in ['0971234567', '+0123', 'javascript:alert(1)', '']) {
      expect(
        buildSupportChatAddress(supportWhatsAppNumber: number, referenceCode: '6F1C-2D3E'),
        isNull,
        reason: number,
      );
    }
  });
}
