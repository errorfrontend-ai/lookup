import 'dart:convert';
import 'dart:typed_data';

import 'fake_http_client_adapter.dart';

/// One file part of a received multipart form.
final class ReceivedFilePart {
  const ReceivedFilePart({
    required this.fieldName,
    required this.fileName,
    required this.contentType,
    required this.bytes,
  });

  final String fieldName;
  final String fileName;
  final String contentType;
  final Uint8List bytes;
}

/// A `multipart/form-data` body as the API would receive it, read back from a request the fake
/// HTTP adapter recorded, so tests check what was sent rather than how it was built: the text
/// fields in order, and the file part with its bytes exactly.
final class ReceivedMultipartForm {
  const ReceivedMultipartForm({required this.textFields, required this.fileParts});

  /// Reads [request]'s body by the boundary in its `Content-Type`. Fails the test when the body is
  /// not a multipart form.
  factory ReceivedMultipartForm.of(FakeHttpRequest request) {
    final contentType = request.header('Content-Type') ?? '';
    final boundary = RegExp(r'boundary=([^\s;]+)').firstMatch(contentType)?.group(1);
    if (!contentType.startsWith('multipart/form-data') || boundary == null) {
      throw StateError('The request is not multipart/form-data: "$contentType".');
    }
    // Latin-1 keeps one character per byte, so the audio bytes survive the split exactly.
    final body = latin1.decode(request.bodyBytes);
    final textFields = <MapEntry<String, String>>[];
    final fileParts = <ReceivedFilePart>[];
    final sections = body.split('--$boundary');
    // The first section is the empty preamble and the last is the closing "--".
    for (final section in sections.sublist(1, sections.length - 1)) {
      final headerEnd = section.indexOf('$_lineBreak$_lineBreak');
      final headers = section.substring(_lineBreak.length, headerEnd);
      final value = section.substring(
        headerEnd + 2 * _lineBreak.length,
        section.length - _lineBreak.length,
      );
      final fieldName = RegExp(r'name="([^"]*)"').firstMatch(headers)!.group(1)!;
      final fileName = RegExp(r'filename="([^"]*)"').firstMatch(headers)?.group(1);
      if (fileName == null) {
        textFields.add(MapEntry(fieldName, utf8.decode(latin1.encode(value))));
      } else {
        fileParts.add(
          ReceivedFilePart(
            fieldName: fieldName,
            fileName: fileName,
            contentType:
                RegExp(
                  r'content-type: ([^\r\n]+)',
                  caseSensitive: false,
                ).firstMatch(headers)?.group(1) ??
                '',
            bytes: Uint8List.fromList(latin1.encode(value)),
          ),
        );
      }
    }
    return ReceivedMultipartForm(textFields: textFields, fileParts: fileParts);
  }

  /// Name and value of each text field, in the order they were sent.
  final List<MapEntry<String, String>> textFields;

  final List<ReceivedFilePart> fileParts;

  /// The text fields by name.
  Map<String, String> get fieldValues => Map.fromEntries(textFields);

  /// The multipart line break, carriage return and line feed, by code.
  static final String _lineBreak = String.fromCharCodes(const [13, 10]);
}
