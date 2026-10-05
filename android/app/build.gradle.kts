plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "com.voxden.android"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.voxden.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Whether this build sells Pro through the web checkout. On for debug and the sideloaded beta; off for the
        // release (Play) build below, where Google Play Billing has to be used instead.
        buildConfigField("boolean", "WEB_CHECKOUT", "true")
        // Whether this build sells Pro through Google Play Billing: the release (Play) build only. Play's payments
        // policy bars any other way of paying for a subscription inside an app on Play.
        buildConfigField("boolean", "PLAY_BILLING", "false")
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-beta" }
        release {
            isMinifyEnabled = false
            buildConfigField("boolean", "WEB_CHECKOUT", "false")
            buildConfigField("boolean", "PLAY_BILLING", "true")
        }
        // Release code (debug hooks off, full Compose speed) signed with this PC's debug key, so testers can
        // sideload it. Not for the Play Store: that needs the real release key.
        create("beta") {
            initWith(getByName("release"))
            buildConfigField("boolean", "WEB_CHECKOUT", "true")
            buildConfigField("boolean", "PLAY_BILLING", "false")
            applicationIdSuffix = ".beta"
            versionNameSuffix = "-beta"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.08.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    // Google Play Billing, for the Play build's Pro subscription (see core/PlayBilling.kt).
    implementation("com.android.billingclient:billing-ktx:8.0.0")
    // Play Billing reaches play-services-basement, which pulls in fragment 1.1.0; release lint refuses that next to
    // registerForActivityResult (InvalidFragmentVersionForActivityResult), so a current one is named here.
    implementation("androidx.fragment:fragment:1.8.9")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    // The real org.json, because the android.jar stubs on the unit-test classpath throw "not mocked".
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
