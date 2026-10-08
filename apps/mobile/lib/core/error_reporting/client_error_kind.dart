/// What kind of failure a crash report describes: the contract's `kind`
/// (packages/contracts/schemas/client-error-report.schema.json), which the API logs so a developer
/// can tell a screen that failed to draw from an error nothing caught (design §3.19).
enum ClientErrorKind {
  /// A widget failed to build, lay out or paint (`FlutterError.onError`).
  render('render'),

  /// An error nothing caught (`PlatformDispatcher.instance.onError`, the isolate error listener).
  uncaught('uncaught'),

  /// A failed future nobody awaited. The portal's word for it; the app's uncaught async errors
  /// arrive as [uncaught], so the app does not send this today.
  unhandledRejection('unhandled-rejection'),

  /// A failure the app noticed and reports on purpose: a phone failure, an answer it could not
  /// read, a request the API refused because the app sent something wrong.
  reported('reported');

  const ClientErrorKind(this.wireName);

  /// The value sent as `kind`.
  final String wireName;
}
