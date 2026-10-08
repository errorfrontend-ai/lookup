/// The codec a clip is recorded in, with the name the recognize request carries in its `codec`
/// field. Only AAC is recorded in Step 4 (S4-D6); the contract also accepts `opus`, which the app
/// has no use for yet, so it is not listed here.
enum AudioCodec {
  /// AAC-LC in an MP4 (M4A) file, whose first bytes carry `ftyp`, the signature the API checks.
  aac('aac');

  const AudioCodec(this.wireName);

  /// The value sent as the `codec` field, e.g. `aac`.
  final String wireName;
}
