package com.voxden.android.services

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the flow bar can work, for the app's setup screens. Contract owned by the lead:
 * the accessibility service calls [setConnected]; the app reads [connected] and [isEnabled].
 */
object FlowBarStatus {
    private val mutableConnected = MutableStateFlow(false)
    /** True while Android has the flow bar's accessibility service bound and running. */
    val connected: StateFlow<Boolean> = mutableConnected.asStateFlow()

    fun setConnected(value: Boolean) { mutableConnected.value = value }

    fun component(context: Context) = ComponentName(context, VoxdenAccessibilityService::class.java)

    /** Whether the user has switched the service on in Android's accessibility settings. */
    fun isEnabled(context: Context): Boolean {
        val wanted = component(context)
        val manager = context.getSystemService(AccessibilityManager::class.java)
        val listed = manager?.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).orEmpty()
            .any { info -> info.resolveInfo?.serviceInfo?.let { it.packageName == wanted.packageName && it.name == wanted.className } == true }
        if (listed) return true
        val setting = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return setting.split(':').any { ComponentName.unflattenFromString(it) == wanted }
    }

    /** Android's accessibility settings, where the user switches the flow bar on. */
    fun accessibilitySettingsIntent(): Intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * This app's info page. On Android 13+ an app installed from an APK file must have
     * "Allow restricted settings" turned on here (top-right menu) before its accessibility
     * service can be switched on.
     */
    fun appInfoIntent(context: Context): Intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:" + context.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
