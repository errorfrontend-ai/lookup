/// One thing wrong with how this copy of the app was built (design §3.7, §2.11). A problem names the
/// setting and the rule it breaks, never the value, so the list can be shown to a developer and
/// compared in tests. Its words are in the ARB file (`SetUpProblemScreen.describe`, design §3.17);
/// listeners only ever see the set-up screen's one plain sentence.
enum ConfigurationProblem {
  flavourNotRecognised,
  gradleFlavourDiffers,
  apiBaseUrlMissing,
  apiBaseUrlMalformed,
  apiBaseUrlNotEndingApiVersion1,
  apiBaseUrlNotHttps,
  errorDetailsFlagNotTrueOrFalse,
  errorDetailsOutsideDevelopment,
  developerToolsFlagNotTrueOrFalse,
  developerToolsOutsideDevelopment,
  verboseLogsFlagNotTrueOrFalse,
  verboseLogsOutsideDevelopment,
  supportWhatsAppNumberMissing,
  supportWhatsAppNumberNotE164,
  outboxSendingDelayNotWholeSeconds,
  outboxSendingDelayOutsideDevelopment,
  outboxBackoffFirstWaitNotWholeSeconds,
  outboxBackoffFirstWaitOutsideDevelopment,
}
