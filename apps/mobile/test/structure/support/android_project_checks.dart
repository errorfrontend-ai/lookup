import 'simple_xml_element.dart';

/// The Android project rules of design §3.7, §3.14 and §3.20 (S4-D6, S4-D14, S4-D25, S4-D33), each a
/// function from a file's contents to a list of problems, so a test can run it on the real file and
/// on a planted copy.
abstract final class AndroidProjectChecks {
  /// The application id every flavour starts from.
  static const String baseApplicationId = 'zm.lookup.listener';

  /// The three flavours: application id and launcher label (§3.7).
  static const Map<String, (String, String)> expectedFlavours = {
    'development': ('zm.lookup.listener.development', 'Look Up (dev)'),
    'staging': ('zm.lookup.listener.staging', 'Look Up (staging)'),
    'production': ('zm.lookup.listener', 'Look Up'),
  };

  /// The only permissions the app's own manifest holds (§3.20; P6 design §3.21): the microphone,
  /// the network, and the saved clips' notifications, asked for only from "Allow notifications".
  static const Set<String> allowedPermissions = {
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.POST_NOTIFICATIONS',
  };

  /// What `workmanager_android` merges for long or expedited work, which the outbox's jobs never
  /// need, and the main manifest removes with `tools:node="remove"` (P6 design §3.10, §3.21).
  static const Set<String> removedPermissions = {
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SHORT_SERVICE',
  };
  static const Set<String> removedServices = {
    'androidx.work.impl.foreground.SystemForegroundService',
  };

  /// The only permission the in-repo `device_services` plugin adds (P6 design §3.15, §3.21): a
  /// normal one, granted at install, to know whether a network is up.
  static const Set<String> devicePluginPermissions = {'android.permission.ACCESS_NETWORK_STATE'};

  /// The cached build tools the plugins are pointed at (§3.20, S4-D33).
  static const String androidGradlePluginVersion = '8.11.1';
  static const String kotlinVersion = '2.2.20';
  static const String gradleVersion = '8.14';

  /// The hosts the development flavour may reach in plain http (§3.7, S4-D30).
  static const Set<String> developmentCleartextHosts = {'10.0.2.2', '127.0.0.1', 'localhost'};

  /// `android/app/build.gradle.kts`: minimum SDK 24, the base id, the three flavours, and no Google
  /// Play services library.
  static List<String> problemsWithAppBuildFile(String buildFile) {
    final text = _withoutLineComments(buildFile);
    final problems = <String>[];
    final defaultConfig = _block(text, RegExp(r'\bdefaultConfig\s*\{'));
    if (defaultConfig == null) return ['build.gradle.kts has no defaultConfig block'];
    final minimumSdk = RegExp(r'\bminSdk(?:Version)?\s*=\s*(\S+)').firstMatch(defaultConfig);
    if (minimumSdk?.group(1) != '24') {
      problems.add('minSdk is ${minimumSdk?.group(1) ?? 'not set'}, not 24 (S4-D6)');
    }
    final applicationId = _quotedValue(defaultConfig, 'applicationId');
    if (applicationId != baseApplicationId) {
      problems.add('applicationId is $applicationId, not $baseApplicationId');
    }
    final dimension = RegExp(
      r'flavorDimensions\s*(?:\+=|=|\.add\()\s*(?:listOf\()?"(\w+)"',
    ).firstMatch(text)?.group(1);
    if (dimension == null) problems.add('no flavour dimension is declared');
    final flavoursBlock = _block(text, RegExp(r'\bproductFlavors\s*\{'));
    if (flavoursBlock == null) return [...problems, 'build.gradle.kts has no productFlavors block'];
    final flavours = <String, (String, String?)>{};
    for (final create in RegExp(r'create\("(\w+)"\)\s*\{').allMatches(flavoursBlock)) {
      final body = _block(flavoursBlock.substring(create.start), RegExp(r'\{'))!;
      if (_quotedValue(body, 'dimension') != dimension) {
        problems.add('flavour ${create.group(1)} is not in the dimension $dimension');
      }
      final id =
          _quotedValue(body, 'applicationId') ??
          '${applicationId ?? ''}${_quotedValue(body, 'applicationIdSuffix') ?? ''}';
      final label = RegExp(
        r'resValue\(\s*"string"\s*,\s*"app_name"\s*,\s*"([^"]*)"\s*\)',
      ).firstMatch(body)?.group(1);
      flavours[create.group(1)!] = (id, label);
    }
    if (flavours.keys.toSet().difference(expectedFlavours.keys.toSet()).isNotEmpty ||
        flavours.length != expectedFlavours.length) {
      problems.add(
        'the flavours are ${flavours.keys.join(', ')}, not '
        '${expectedFlavours.keys.join(', ')} (S4-D25)',
      );
    }
    for (final entry in expectedFlavours.entries) {
      final found = flavours[entry.key];
      if (found == null) continue;
      if (found.$1 != entry.value.$1) {
        problems.add('flavour ${entry.key} has the id ${found.$1}, not ${entry.value.$1}');
      }
      if (found.$2 != entry.value.$2) {
        problems.add('flavour ${entry.key} is labelled ${found.$2}, not ${entry.value.$2}');
      }
    }
    if (RegExp(r'com\.google\.android\.gms|com\.google\.firebase|play-services').hasMatch(text)) {
      problems.add('the app build uses Google Play services (S4-COMPATIBILITY-01)');
    }
    return problems;
  }

  /// `src/main/AndroidManifest.xml`: exactly INTERNET, RECORD_AUDIO and POST_NOTIFICATIONS, backup
  /// off, cleartext off, the network-security configuration, the button queries, no service of its
  /// own, and WorkManager's foreground service and its two permissions removed.
  static List<String> problemsWithMainManifest(String manifestText) {
    final manifest = SimpleXmlElement.parse(manifestText);
    final problems = <String>[];
    final permissions = _permissionsOf(manifest);
    if (permissions.length != allowedPermissions.length ||
        !permissions.toSet().containsAll(allowedPermissions)) {
      problems.add(
        'the permissions are ${permissions.join(', ')}, not exactly INTERNET, RECORD_AUDIO and '
        'POST_NOTIFICATIONS (§3.20; P6 §3.21)',
      );
    }
    final applications = manifest.childrenNamed('application').toList();
    if (applications.length != 1) return [...problems, 'the manifest has no single <application>'];
    final application = applications.single.attributes;
    const expectedAttributes = {
      'android:allowBackup': 'false',
      'android:fullBackupContent': 'false',
      'android:dataExtractionRules': '@xml/data_extraction_rules',
      'android:usesCleartextTraffic': 'false',
      'android:networkSecurityConfig': '@xml/network_security_config',
    };
    for (final entry in expectedAttributes.entries) {
      if (application[entry.key] != entry.value) {
        problems.add('<application> ${entry.key} is ${application[entry.key]}, not ${entry.value}');
      }
    }
    final services = manifest.descendantsNamed('service');
    if (services.any((service) => service.attributes['tools:node'] != 'remove')) {
      problems.add(
        'the manifest declares a service; the app never records in the background '
        '(§3.17)',
      );
    }
    final removed = {
      for (final element in [...manifest.childrenNamed('uses-permission'), ...services])
        if (element.attributes['tools:node'] == 'remove') element.attributes['android:name'],
    };
    for (final name in {...removedPermissions, ...removedServices}) {
      if (!removed.contains(name)) {
        problems.add('the manifest does not remove $name, which WorkManager merges (P6 §3.21)');
      }
    }
    problems.addAll(_problemsWithQueries(manifest));
    return problems;
  }

  /// The `device_services` plugin's manifest: exactly ACCESS_NETWORK_STATE, and no service,
  /// receiver or activity of its own (P6 design §3.16, §3.21).
  static List<String> problemsWithDevicePluginManifest(String manifestText) {
    final manifest = SimpleXmlElement.parse(manifestText);
    final permissions = _permissionsOf(manifest);
    return [
      if (permissions.length != devicePluginPermissions.length ||
          !permissions.toSet().containsAll(devicePluginPermissions))
        'the device_services permissions are ${permissions.join(', ')}, not exactly '
            'ACCESS_NETWORK_STATE (P6 §3.21)',
      for (final component in ['service', 'receiver', 'activity', 'provider'])
        if (manifest.descendantsNamed(component).isNotEmpty)
          'the device_services manifest declares a $component (P6 §3.16)',
    ];
  }

  /// A manifest of another source set (debug, profile, a flavour): no permission beyond the three,
  /// and cleartext allowed only in the development flavour.
  static List<String> problemsWithSourceSetManifest(String sourceSet, String manifestText) {
    final manifest = SimpleXmlElement.parse(manifestText);
    return [
      for (final permission in _permissionsOf(manifest))
        if (!allowedPermissions.contains(permission))
          'the $sourceSet manifest adds $permission (§3.20)',
      for (final application in manifest.childrenNamed('application'))
        if (application.attributes['android:usesCleartextTraffic'] == 'true' &&
            sourceSet != 'development')
          'the $sourceSet manifest allows cleartext; only development may (S4-D25)',
    ];
  }

  /// `res/xml/data_extraction_rules.xml`: cloud backup and device transfer exclude everything.
  static List<String> problemsWithDataExtractionRules(String rulesText) {
    final rules = SimpleXmlElement.parse(rulesText);
    final problems = <String>[];
    const domains = {'root', 'file', 'database', 'sharedpref', 'external'};
    for (final sectionName in ['cloud-backup', 'device-transfer']) {
      final sections = rules.childrenNamed(sectionName).toList();
      if (sections.length != 1) {
        problems.add('data_extraction_rules.xml has no single <$sectionName>');
        continue;
      }
      final excluded = {
        for (final exclude in sections.single.childrenNamed('exclude'))
          exclude.attributes['domain'],
      };
      if (!excluded.containsAll(domains)) {
        problems.add('<$sectionName> does not exclude ${domains.difference(excluded).join(', ')}');
      }
      if (sections.single.childrenNamed('include').isNotEmpty) {
        problems.add('<$sectionName> includes something; nothing is backed up (S4-D14)');
      }
    }
    return problems;
  }

  /// The main network-security configuration: cleartext off everywhere, system certificates only.
  static List<String> problemsWithMainNetworkSecurity(String configurationText) {
    final configuration = SimpleXmlElement.parse(configurationText);
    return [
      ..._problemsWithBaseConfiguration(configuration, 'main'),
      for (final element in [configuration, ...configuration.descendantsNamed('domain-config')])
        if (element.attributes['cleartextTrafficPermitted'] == 'true')
          'the main configuration allows cleartext; only development may (S4-D25)',
    ];
  }

  /// The development network-security configuration: cleartext only for the emulator's view of
  /// the PC and the device itself.
  static List<String> problemsWithDevelopmentNetworkSecurity(String configurationText) {
    final configuration = SimpleXmlElement.parse(configurationText);
    final problems = _problemsWithBaseConfiguration(configuration, 'development');
    final cleartextHosts = <String>{};
    for (final domainConfiguration in configuration.descendantsNamed('domain-config')) {
      if (domainConfiguration.attributes['cleartextTrafficPermitted'] != 'true') continue;
      for (final domain in domainConfiguration.childrenNamed('domain')) {
        cleartextHosts.add(domain.text);
        if (domain.attributes['includeSubdomains'] != 'false') {
          problems.add('cleartext to ${domain.text} must not include its subdomains');
        }
      }
    }
    if (cleartextHosts.length != developmentCleartextHosts.length ||
        !cleartextHosts.containsAll(developmentCleartextHosts)) {
      problems.add(
        'development allows cleartext to ${cleartextHosts.join(', ')}, not exactly '
        '${developmentCleartextHosts.join(', ')} (S4-D25)',
      );
    }
    return problems;
  }

  /// A network-security configuration in a source set other than main and development.
  static List<String> problemsWithOtherNetworkSecurity(String sourceSet, String configurationText) {
    final configuration = SimpleXmlElement.parse(configurationText);
    return [
      for (final element in [
        configuration,
        ...configuration.descendantsNamed('base-config'),
        ...configuration.descendantsNamed('domain-config'),
      ])
        if (element.attributes['cleartextTrafficPermitted'] == 'true')
          'the $sourceSet network-security configuration allows cleartext (S4-D25)',
    ];
  }

  /// `android/settings.gradle.kts`: the cached plugin versions, and the plugins' own build scripts
  /// pointed at them so Gradle downloads no other version (S4-D33).
  static List<String> problemsWithSettingsFile(String settingsFile) {
    final text = _withoutLineComments(settingsFile);
    final problems = <String>[];
    final pluginsBlock = _block(text, RegExp(r'^plugins\s*\{', multiLine: true)) ?? '';
    for (final (pluginId, version) in [
      ('com.android.application', androidGradlePluginVersion),
      ('org.jetbrains.kotlin.android', kotlinVersion),
    ]) {
      final declared = RegExp(
        'id\\("${RegExp.escape(pluginId)}"\\)\\s*version\\s*"([^"]+)"',
      ).firstMatch(pluginsBlock)?.group(1);
      if (declared != version) {
        problems.add('the plugin $pluginId is ${declared ?? 'not declared'}, not $version');
      }
    }
    final beforeProject = _block(text, RegExp(r'gradle\.beforeProject\s*\{'));
    if (beforeProject == null || !beforeProject.contains('buildscript.configurations')) {
      return [
        ...problems,
        "settings.gradle.kts does not point the plugins' build scripts at the "
            'cached versions (S4-D33)',
      ];
    }
    for (final (group, name, version) in [
      ('com.android.tools.build', 'gradle', androidGradlePluginVersion),
      ('org.jetbrains.kotlin', 'kotlin-gradle-plugin', kotlinVersion),
    ]) {
      final pointedAt = RegExp(
        'requested\\.group\\s*==\\s*"${RegExp.escape(group)}"\\s*&&\\s*requested\\.name\\s*==\\s*'
        '"${RegExp.escape(name)}"\\s*\\)\\s*\\{\\s*useVersion\\("([^"]+)"\\)',
      ).firstMatch(beforeProject)?.group(1);
      if (pointedAt != version) {
        problems.add('$group:$name is pointed at ${pointedAt ?? 'nothing'}, not $version');
      }
    }
    return problems;
  }

  /// `android/gradle.properties`: at most a 3 GB heap, two workers, Kotlin in process (§3.20).
  static List<String> problemsWithGradleProperties(String propertiesText) {
    final properties = _properties(propertiesText);
    final problems = <String>[];
    final heap = RegExp(r'-Xmx(\d+)([gGmM])').firstMatch(properties['org.gradle.jvmargs'] ?? '');
    final heapMegabytes = heap == null
        ? null
        : int.parse(heap.group(1)!) * (heap.group(2)!.toLowerCase() == 'g' ? 1024 : 1);
    if (heapMegabytes == null || heapMegabytes > 3 * 1024) {
      problems.add('the Gradle heap is ${heap?.group(0) ?? 'not capped'}; at most -Xmx3g (§3.20)');
    }
    if (properties['org.gradle.workers.max'] != '2') {
      problems.add('org.gradle.workers.max is ${properties['org.gradle.workers.max']}, not 2');
    }
    if (properties['kotlin.compiler.execution.strategy'] != 'in-process') {
      problems.add(
        'kotlin.compiler.execution.strategy is '
        '${properties['kotlin.compiler.execution.strategy']}, not in-process',
      );
    }
    return problems;
  }

  /// `gradle/wrapper/gradle-wrapper.properties`: the cached Gradle (§3.20).
  static List<String> problemsWithGradleWrapper(String propertiesText) {
    final address = _properties(propertiesText)['distributionUrl'] ?? '';
    return [
      if (!address.contains('gradle-$gradleVersion-'))
        'the Gradle wrapper uses $address, not Gradle $gradleVersion (§3.20)',
    ];
  }

  static List<String> _problemsWithQueries(SimpleXmlElement manifest) {
    final found = <String>{};
    final problems = <String>[];
    for (final queries in manifest.childrenNamed('queries')) {
      for (final entry in queries.children) {
        if (entry.name != 'intent') {
          problems.add('<queries> holds a <${entry.name}>; only the button intents (§3.14)');
          continue;
        }
        final actions = [
          for (final action in entry.childrenNamed('action'))
            action.attributes['android:name']?.split('.').last,
        ];
        final data = entry.childrenNamed('data').map((element) => element.attributes).toList();
        final scheme = data.map((attributes) => attributes['android:scheme']).nonNulls.join(',');
        final mimeType = data
            .map((attributes) => attributes['android:mimeType'])
            .nonNulls
            .join(',');
        found.add('${actions.join(',')} ${scheme.isEmpty ? mimeType : scheme}');
      }
    }
    const required = {'VIEW https', 'VIEW tel', 'DIAL tel'};
    const allowed = {...required, 'PROCESS_TEXT text/plain'};
    for (final intent in required.difference(found)) {
      problems.add('<queries> lacks $intent (S4-LINKS-13)');
    }
    for (final intent in found.difference(allowed)) {
      problems.add('<queries> holds $intent, which no button needs (§3.14)');
    }
    return problems;
  }

  static List<String> _problemsWithBaseConfiguration(
    SimpleXmlElement configuration,
    String sourceSet,
  ) {
    final problems = <String>[];
    final bases = configuration.childrenNamed('base-config').toList();
    if (bases.length != 1 || bases.single.attributes['cleartextTrafficPermitted'] != 'false') {
      problems.add('the $sourceSet configuration does not turn cleartext off in <base-config>');
    }
    final certificateSources = {
      for (final certificates in configuration.descendantsNamed('certificates'))
        certificates.attributes['src'],
    };
    if (certificateSources.length != 1 || certificateSources.single != 'system') {
      problems.add(
        'the $sourceSet configuration trusts ${certificateSources.join(', ')}; only the '
        'system certificate authorities (§3.7)',
      );
    }
    return problems;
  }

  static List<String> _permissionsOf(SimpleXmlElement manifest) => [
    for (final name in ['uses-permission', 'uses-permission-sdk-23'])
      for (final permission in manifest.childrenNamed(name))
        if (permission.attributes['tools:node'] != 'remove')
          permission.attributes['android:name'] ?? '(unnamed)',
  ];

  static String? _quotedValue(String text, String name) =>
      RegExp('\\b${RegExp.escape(name)}\\s*=\\s*"([^"]*)"').firstMatch(text)?.group(1);

  static Map<String, String> _properties(String text) => {
    for (final line in text.split('\n'))
      if (line.trim().isNotEmpty && !line.trimLeft().startsWith('#') && line.contains('='))
        line.substring(0, line.indexOf('=')).trim(): line.substring(line.indexOf('=') + 1).trim(),
  };

  /// Removes `//` comments, leaving `https://` inside strings alone.
  static String _withoutLineComments(String text) =>
      text.replaceAllMapped(RegExp(r'(^|[^:"])//.*$', multiLine: true), (match) => match.group(1)!);

  /// The text inside the braces that open where [header] matches, or null when it does not match.
  static String? _block(String text, RegExp header) {
    final match = header.firstMatch(text);
    if (match == null) return null;
    final opening = text.indexOf('{', match.start);
    var depth = 0;
    var isInString = false;
    for (var index = opening; index < text.length; index++) {
      final character = text[index];
      if (character == '"' && text[index - 1] != r'\') isInString = !isInString;
      if (isInString) continue;
      if (character == '{') depth++;
      if (character == '}') {
        depth--;
        if (depth == 0) return text.substring(opening + 1, index);
      }
    }
    return null;
  }
}
