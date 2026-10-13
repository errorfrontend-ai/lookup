import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/identifiers/uuid_shape.dart';

/// The UUID shape install ids and recognition ids are checked against before they are trusted.
void main() {
  test('a lower-case UUID of version 1 to 8 with the RFC variant fits', () {
    for (final uuid in [
      '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
      '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
      '6f1c2d3e-4b5a-1c7d-ae8f-0a1b2c3d4e5f',
      '6f1c2d3e-4b5a-8c7d-be8f-0a1b2c3d4e5f',
      RandomUuid().generate(),
    ]) {
      expect(UuidShape.isLowerCaseUuid(uuid), isTrue, reason: uuid);
    }
  });

  test('anything else does not', () {
    for (final notOne in [
      '0199B2C4-5A6E-7C3D-8F10-2B3C4D5E6F70',
      '0199b2c4-5a6e-0c3d-8f10-2b3c4d5e6f70',
      '0199b2c4-5a6e-9c3d-8f10-2b3c4d5e6f70',
      '0199b2c4-5a6e-7c3d-cf10-2b3c4d5e6f70',
      '0199b2c45a6e7c3d8f102b3c4d5e6f70',
      ' 0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
      '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70\n',
      '0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70/extra',
      '../0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70',
      '',
    ]) {
      expect(UuidShape.isLowerCaseUuid(notOne), isFalse, reason: notOne);
    }
  });
}
