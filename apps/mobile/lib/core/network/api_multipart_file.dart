/// The one file part of a multipart request. `ApiClient` sends it after every text field, because
/// the API reads the text fields first and checks them before it accepts any audio (design §3.10:
/// the `audio` part, `clip.m4a`, `audio/mp4`, last).
final class ApiMultipartFile {
  const ApiMultipartFile({
    required this.fieldName,
    required this.fileName,
    required this.contentType,
    required this.bytes,
  });

  /// The part's name in the form, e.g. `audio`.
  final String fieldName;

  /// The file name sent with the part, e.g. `clip.m4a`.
  final String fileName;

  /// The part's media type, e.g. `audio/mp4`.
  final String contentType;

  /// The file's bytes, sent as they are.
  final List<int> bytes;
}
