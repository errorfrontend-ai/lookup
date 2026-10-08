/// One thing wrong with how this copy of the app was built (design §3.7, §2.11). A problem names the
/// setting and the rule it breaks, never the value, so the list can be shown to a developer and
/// compared in tests. Listeners only ever see the set-up screen's one plain sentence.
enum ConfigurationProblem {
  flavourNotRecognised('LOOKUP_FLAVOUR is missing or is not development, staging or production.'),
  gradleFlavourDiffers('The Android build flavour (--flavor) is not the one LOOKUP_FLAVOUR names.'),
  apiBaseUrlMissing('LOOKUP_API_BASE_URL is missing.'),
  apiBaseUrlMalformed(
    'LOOKUP_API_BASE_URL is not a plain http or https address with a host '
    '(no spaces, user name, query or fragment).',
  ),
  apiBaseUrlNotEndingApiVersion1('LOOKUP_API_BASE_URL does not end with /api/v1.'),
  apiBaseUrlNotHttps('LOOKUP_API_BASE_URL must use https outside the development flavour.'),
  errorDetailsFlagNotTrueOrFalse('LOOKUP_SHOW_ERROR_DETAILS is neither true nor false.'),
  errorDetailsOutsideDevelopment(
    'LOOKUP_SHOW_ERROR_DETAILS is on outside the development flavour.',
  ),
  developerToolsFlagNotTrueOrFalse('LOOKUP_SHOW_DEVELOPER_TOOLS is neither true nor false.'),
  developerToolsOutsideDevelopment(
    'LOOKUP_SHOW_DEVELOPER_TOOLS is on outside the development flavour.',
  ),
  verboseLogsFlagNotTrueOrFalse('LOOKUP_VERBOSE_LOGS is neither true nor false.'),
  verboseLogsOutsideDevelopment('LOOKUP_VERBOSE_LOGS is on outside the development flavour.'),
  supportWhatsAppNumberMissing(
    'LOOKUP_SUPPORT_WHATSAPP_NUMBER is missing; staging and production builds must have it.',
  ),
  supportWhatsAppNumberNotE164(
    'LOOKUP_SUPPORT_WHATSAPP_NUMBER is not an E.164 number such as +260971234567.',
  );

  const ConfigurationProblem(this.developerDescription);

  /// What is wrong, in words a developer can act on. Shown only in a development build.
  final String developerDescription;
}
