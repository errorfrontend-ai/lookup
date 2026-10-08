import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/recognition_failure.dart';

const String _apiRequestId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
const String _reportRequestId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

void main() {
  test('there are exactly six failures, one per Error screen variant', () {
    const oneOfEachFailure = <RecognitionFailure>[
      ServerFailure(requestId: _apiRequestId),
      PhoneFailure(reportRequestId: _reportRequestId, reportDelivery: ReportDelivery.sending),
      RecordingUnusableFailure(requestId: _apiRequestId),
      ConnectionFailure(),
      TooManyTriesFailure(isShortWait: true),
      NewerAppNeededFailure(isSeveralStations: false),
    ];
    // No default branch: a seventh failure would not compile until it is named here.
    final variants = oneOfEachFailure.map(
      (failure) => switch (failure) {
        ServerFailure() => 'server failure',
        PhoneFailure() => 'phone failure',
        RecordingUnusableFailure() => 'recording unusable',
        ConnectionFailure() => 'no connection',
        TooManyTriesFailure() => 'too many tries',
        NewerAppNeededFailure() => 'newer app needed',
      },
    );
    expect(variants.toSet(), hasLength(6));
  });

  group('a code may be shown only for an id the API logged or a report it accepted (S4-D9)', () {
    test('a server failure and an unusable recording show the code of the API id', () {
      expect(const ServerFailure(requestId: _apiRequestId).referenceCodeRequestId, _apiRequestId);
      expect(
        const RecordingUnusableFailure(requestId: _apiRequestId).referenceCodeRequestId,
        _apiRequestId,
      );
    });

    test('a phone failure shows its report id only once the API has accepted the report', () {
      for (final delivery in ReportDelivery.values) {
        final failure = PhoneFailure(reportRequestId: _reportRequestId, reportDelivery: delivery);
        expect(
          failure.referenceCodeRequestId,
          delivery == ReportDelivery.accepted ? _reportRequestId : isNull,
          reason: delivery.name,
        );
      }
    });

    test('no connection, too many tries and newer app needed show no code', () {
      for (final failure in const <RecognitionFailure>[
        ConnectionFailure(),
        TooManyTriesFailure(isShortWait: true),
        TooManyTriesFailure(isShortWait: false),
        NewerAppNeededFailure(isSeveralStations: true),
        NewerAppNeededFailure(isSeveralStations: false),
      ]) {
        expect(failure.referenceCodeRequestId, isNull, reason: '$failure');
      }
    });
  });

  test('failures compare by value', () {
    expect(
      const PhoneFailure(reportRequestId: _reportRequestId, reportDelivery: ReportDelivery.sending),
      isNot(
        const PhoneFailure(
          reportRequestId: _reportRequestId,
          reportDelivery: ReportDelivery.accepted,
        ),
      ),
    );
    expect(const ServerFailure(requestId: 'a'), isNot(const ServerFailure(requestId: 'b')));
    expect(
      const ServerFailure(requestId: 'a'),
      isNot(const RecordingUnusableFailure(requestId: 'a')),
    );
    expect(const ConnectionFailure(), const ConnectionFailure());
    expect(
      const NewerAppNeededFailure(isSeveralStations: true),
      isNot(const NewerAppNeededFailure(isSeveralStations: false)),
    );
  });
}
