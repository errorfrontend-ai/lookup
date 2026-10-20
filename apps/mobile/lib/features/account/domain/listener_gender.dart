/// What a listener says about themselves at sign-up (ADR-005). The dashboard shows groups of these, never a person.
/// [apiName] is the contract's value.
enum ListenerGender {
  female('FEMALE'),
  male('MALE'),
  another('ANOTHER'),
  preferNotToSay('PREFER_NOT_TO_SAY');

  const ListenerGender(this.apiName);

  /// The value the API's contract names (`LISTENER_GENDERS`).
  final String apiName;
}
