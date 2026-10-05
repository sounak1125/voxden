package com.voxden.android

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.voxden.android.core.AppController
import com.voxden.android.core.DictationSource
import com.voxden.android.core.ProUpgrade
import com.voxden.android.core.RecordingPhase
import com.voxden.android.core.SensitiveClip
import com.voxden.android.services.FlowBarStatus
import com.voxden.android.services.MicrophoneService
import com.voxden.android.ui.AppActions
import com.voxden.android.ui.DebugHooks
import com.voxden.android.ui.DictateUi
import com.voxden.android.ui.Haptic
import com.voxden.android.ui.SetupStatus
import com.voxden.android.ui.VoxdenApp
import com.voxden.android.ui.VoxdenTheme
import com.voxden.android.ui.shortError
import com.voxden.android.ui.vox
import kotlinx.coroutines.launch

/** Hosts the Compose app and does the things only an Activity can: permissions, the microphone service, intents. */
class MainActivity : ComponentActivity(), AppActions {
    private val controller by lazy { AppController.get(this) }
    private val dictateUi = DictateUi()
    private val setup by lazy { SetupStatus(this) }
    private val askedPrefs by lazy { getSharedPreferences("voxden_permission_asks", MODE_PRIVATE) }
    private var startAfterPermission = false

    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        setup.refresh()
        if (startAfterPermission) {
            startAfterPermission = false
            if (granted) beginRecording()
            else {
                controller.reportError("Allow microphone access to dictate. You can turn it on in App permissions.")
                dictateUi.error("Mic unavailable")
            }
        }
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { setup.refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val canvas = Color.parseColor("#0B0C0D")
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(canvas), navigationBarStyle = SystemBarStyle.dark(canvas))
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        setContent { VoxdenTheme { VoxdenApp(controller, this, setup, dictateUi) } }
        controller.refreshAccountQuietly()
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.CREATED) {
                controller.results.collect { result -> if (result.source == DictationSource.APP) onDictationFinished(result.text, result.error) }
            }
        }
        handleDebugIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDebugIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        setup.refresh()
    }

    override fun onStop() {
        if (!isChangingConfigurations && controller.state.value.phase == RecordingPhase.RECORDING) {
            controller.cancelRecording()
            MicrophoneService.stop(this)
        }
        super.onStop()
    }

    private fun handleDebugIntent(intent: Intent?) {
        if (!BuildConfig.DEBUG) return
        intent?.getStringExtra("debug_cmd")?.let { DebugHooks.run(it, controller) }
    }

    private fun buzz(kind: Haptic) {
        if (controller.state.value.flowBar.haptics) window.decorView.vox(kind)
    }

    /** A dictation started in the app ended: copy it, and tell the capsule. */
    private fun onDictationFinished(text: String, error: String?) {
        if (error != null) {
            dictateUi.error(shortError(error))
            buzz(Haptic.REJECT)
        } else {
            copy(text)
            dictateUi.done("Copied")
            buzz(Haptic.CONFIRM)
        }
    }

    private fun beginRecording() {
        try {
            MicrophoneService.start(this)
            val started = controller.startRecording(DictationSource.APP)
            if (controller.state.value.phase == RecordingPhase.IDLE) MicrophoneService.stop(this)
            if (!started) controller.state.value.error?.let { dictateUi.error(shortError(it)) }
        } catch (_: Exception) {
            controller.cancelRecording()
            MicrophoneService.stop(this)
            controller.reportError("Could not start the microphone. Reopen Voxden and try again.")
            dictateUi.error("Mic unavailable")
        }
    }

    // AppActions
    override fun startDictation() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) beginRecording()
        else {
            startAfterPermission = true
            requestMicrophone()
        }
    }

    override fun requestMicrophone() {
        val asked = askedPrefs.getBoolean(Manifest.permission.RECORD_AUDIO, false)
        // After two refusals Android stops showing its dialog; send the user to App info instead.
        if (asked && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
            startAfterPermission = false
            openAppInfo()
        } else {
            askedPrefs.edit().putBoolean(Manifest.permission.RECORD_AUDIO, true).apply()
            microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    override fun requestNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        val asked = askedPrefs.getBoolean(Manifest.permission.POST_NOTIFICATIONS, false)
        if (asked && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) openNotificationSettings()
        else {
            askedPrefs.edit().putBoolean(Manifest.permission.POST_NOTIFICATIONS, true).apply()
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun openAccessibilitySettings() = launchSafely(FlowBarStatus.accessibilitySettingsIntent())
    override fun openAppInfo() = launchSafely(FlowBarStatus.appInfoIntent(this))
    override fun openNotificationSettings() = launchSafely(
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
    )
    override fun openKeyboardSettings() = launchSafely(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
    override fun showKeyboardPicker() { getSystemService(InputMethodManager::class.java)?.showInputMethodPicker() }
    override fun openUrl(url: String): Boolean {
        if (!ProUpgrade.isSecureUrl(url)) { controller.reportError("Voxden only opens secure links."); return false }
        return launched(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    override fun copy(text: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(SensitiveClip.of(text))
    }

    override fun share(text: String) {
        launchSafely(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text)
        }, "Share dictation"))
    }

    private fun launchSafely(intent: Intent) { launched(intent) }

    /** Starts [intent]. False, after telling the user, when this phone has nothing to open it with or refuses to. */
    private fun launched(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        controller.reportError("Android couldn't open that screen on this phone.")
        false
    } catch (_: SecurityException) {
        controller.reportError("Android couldn't open that screen on this phone.")
        false
    }
}
