import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/identifiers/reference_code.dart';

import '../../support/repository_file_locator.dart';

/// One case of packages/contracts/fixtures/errors/reference-codes.json, the fixture the TypeScript
/// helper is tested against too.
typedef _ReferenceCodeCase = ({String description, String requestId, String? referenceCode});

List<_ReferenceCodeCase> _loadReferenceCodeCases() {
  final decoded = jsonDecode(
    RepositoryFileLocator.file(
      'packages/contracts/fixtures/errors/reference-codes.json',
    ).readAsStringSync(),
  );
  if (decoded is! List<Object?>) {
    throw const FormatException('reference-codes.json must be a list');
  }
  return [
    for (final entry in decoded)
      if (entry case {
        'description': final String description,
        'request_id': final String requestId,
        'reference_code': final String? referenceCode,
      })
        (description: description, requestId: requestId, referenceCode: referenceCode)
      else
        throw FormatException('Unreadable reference-code case: $entry'),
  ];
}

void main() {
  final cases = _loadReferenceCodeCases();

  test('the shared fixture has codes and refusals to check', () {
    expect(cases.where((each) => each.referenceCode != null), isNotEmpty);
    expect(cases.where((each) => each.referenceCode == null), isNotEmpty);
  });

  for (final referenceCodeCase in cases) {
    test(referenceCodeCase.description, () {
      expect(
        ReferenceCode.forRequestId(referenceCodeCase.requestId),
        referenceCodeCase.referenceCode,
        reason: 'request id "${referenceCodeCase.requestId}"',
      );
    });
  }
}
