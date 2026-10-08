plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "zm.lookup.listener"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "zm.lookup.listener"
        // Android 7.0: url_launcher and shared_preferences need 24, record 23 (design S4-D6).
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // The build's Dart settings (config/<flavour>-*.json) must name the same flavour; the app refuses
    // to start otherwise (design §3.7, S4-D25).
    flavorDimensions += "environment"
    productFlavors {
        create("development") {
            dimension = "environment"
            applicationIdSuffix = ".development"
            resValue("string", "app_name", "Look Up (dev)")
        }
        create("staging") {
            dimension = "environment"
            applicationIdSuffix = ".staging"
            resValue("string", "app_name", "Look Up (staging)")
        }
        create("production") {
            dimension = "environment"
            resValue("string", "app_name", "Look Up")
        }
    }

    buildTypes {
        release {
            // Test builds for the emulator and the user's phone are signed with the debug key; a real
            // signing key is a deployment task (P8).
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

flutter {
    source = "../.."
}
