/// Whether this phone has a listener account and, if so, its email in the masked form the server gives
/// ("a***@gmail.com"). The app never holds the full address, the gender or the age.
final class AccountSummary {
  const AccountSummary({required this.isSignedIn, this.emailMasked});

  final bool isSignedIn;

  /// Null when [isSignedIn] is false.
  final String? emailMasked;

  @override
  bool operator ==(Object other) =>
      other is AccountSummary && other.isSignedIn == isSignedIn && other.emailMasked == emailMasked;

  @override
  int get hashCode => Object.hash(AccountSummary, isSignedIn, emailMasked);

  @override
  String toString() => 'AccountSummary(isSignedIn: $isSignedIn)';
}
