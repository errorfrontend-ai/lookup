import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/identifiers/random_uuid.dart';
import 'package:lookup_listener/core/identifiers/reference_code.dart';

import '../../support/repository_file_locator.dart';

/// A version-4 UUID exactly: lower case, version digit 4, variant 8, 9, a or b.
final RegExp _versionFourUuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

/// The UUID pattern the API's contract uses for ids the app sends (install_id), read from the
/// emitted JSON Schema so the test follows the contract if it changes.
RegExp _contractUuidPattern() {
  final schema =
      jsonDecode(
            RepositoryFileLocator.file(
              'packages/contracts/schemas/register-install-input.schema.json',
            ).readAsStringSync(),
          )
          as Map<String, Object?>;
  final definitions = schema[r'$defs']! as Map<String, Object?>;
  final input = definitions['RegisterInstallInput']! as Map<String, Object?>;
  final properties = input['properties']! as Map<String, Object?>;
  final installId = properties['install_id']! as Map<String, Object?>;
  return RegExp(installId['pattern']! as String);
}

/// A random source that always gives the same number, to prove the version and variant bits are
/// forced whatever the random bytes are.
class _ConstantRandom implements Random {
  _ConstantRandom(this.value);

  final int value;

  @override
  int nextInt(int max) => value;

  @override
  bool nextBool() => false;

  @override
  double nextDouble() => 0;
}

void main() {
  test('makes version-4 UUIDs the API contract accepts', () {
    final contractPattern = _contractUuidPattern();
    final uuids = RandomUuid();
    for (var draw = 0; draw < 1000; draw++) {
      final uuid = uuids.generate();
      expect(uuid, matches(_versionFourUuid));
      expect(contractPattern.hasMatch(uuid), isTrue, reason: uuid);
      // The API logs it as the request id, so support can find it from the reference code.
      expect(ReferenceCode.forRequestId(uuid), isNotNull, reason: uuid);
    }
  });

  test('10,000 draws are all different', () {
    final uuids = RandomUuid();
    final drawn = {for (var draw = 0; draw < 10000; draw++) uuids.generate()};
    expect(drawn, hasLength(10000));
  });

  test('forces the version and variant bits whatever the random bytes are', () {
    expect(
      RandomUuid(random: _ConstantRandom(255)).generate(),
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    );
    expect(
      RandomUuid(random: _ConstantRandom(0)).generate(),
      '00000000-0000-4000-8000-000000000000',
    );
  });

  test('takes its 16 bytes from the random source it is given', () {
    final seeded = RandomUuid(random: Random(7)).generate();
    expect(RandomUuid(random: Random(7)).generate(), seeded);
    expect(seeded, matches(_versionFourUuid));
  });
}
