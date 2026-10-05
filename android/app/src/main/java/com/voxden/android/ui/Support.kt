package com.voxden.android.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.core.AppController
import com.voxden.android.core.DictationSource
import com.voxden.android.core.HistoryEntry
import com.voxden.android.services.FlowBarStatus
import com.voxden.android.ui.island.IslandMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Things only an Activity can do. MainActivity implements this; the Compose UI never touches Android services directly. */
@Stable
interface AppActions {
    /** Asks for the microphone if needed, then starts a dictation in the app. */
    fun startDictation()
    fun requestMicrophone()
    fun requestNotifications()
    fun openAccessibilitySettings()
    fun openAppInfo()
    fun openNotificationSettings()
    fun openKeyboardSettings()
    fun showKeyboardPicker()
    /** Opens a secure (`https`) web page. False, after telling the user, when it could not be opened. */
    fun openUrl(url: String): Boolean
    fun copy(text: String)
    fun share(text: String)
}

/** The three setup checks, refreshed whenever the app resumes or Android's accessibility setting changes. */
@Stable
class SetupStatus(context: Context) {
    private val app = context.applicationContext
    var microphone by mutableStateOf(false); private set
    var notifications by mutableStateOf(false); private set
    var flowBar by mutableStateOf(false); private set
    /** Android 13+ asks for notifications at runtime; before that the row is not shown. */
    val needsNotificationPermission: Boolean get() = Build.VERSION.SDK_INT >= 33
    /** A restricted-settings block only applies to apps installed from a file, not from the Play Store. */
    val installedFromStore: Boolean = runCatching {
        val installer = if (Build.VERSION.SDK_INT >= 30) app.packageManager.getInstallSourceInfo(app.packageName).installingPackageName
        else @Suppress("DEPRECATION") app.packageManager.getInstallerPackageName(app.packageName)
        installer == "com.android.vending"
    }.getOrDefault(false)

    init { refresh() }

    fun refresh() {
        microphone = app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        notifications = Build.VERSION.SDK_INT < 33 || app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        flowBar = FlowBarStatus.isEnabled(app) || FlowBarStatus.connected.value
    }

    val required: Boolean get() = microphone && flowBar
}

/** Re-reads [SetupStatus] when Android's list of enabled accessibility services changes, so a row can turn green live. */
@Composable
fun ObserveSetup(status: SetupStatus) {
    val context = LocalContext.current
    DisposableEffect(status) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) = status.refresh()
        }
        context.contentResolver.registerContentObserver(Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES), false, observer)
        onDispose { context.contentResolver.unregisterContentObserver(observer) }
    }
}

/** A short-lived state on the in-app Dictate capsule after a dictation ends ("Copied", or an error). */
data class DictateFlash(val mode: IslandMode, val label: String, val id: Long)

@Stable
class DictateUi {
    var flash by mutableStateOf<DictateFlash?>(null); private set
    private var counter = 0L
    fun done(label: String) { flash = DictateFlash(IslandMode.DONE, label, ++counter) }
    fun error(label: String) { flash = DictateFlash(IslandMode.ERROR, label, ++counter) }
    fun clear(id: Long) { if (flash?.id == id) flash = null }
}

data class PolishFailure(val id: String, val message: String, val seq: Long)

/** Runs Polish for a dictation so the list row and the detail sheet share one in-flight state. */
@Stable
class PolishRunner(private val controller: AppController, private val scope: CoroutineScope) {
    /** Dictation id to the mode that is running. */
    var running by mutableStateOf<Map<String, String>>(emptyMap()); private set
    var failure by mutableStateOf<PolishFailure?>(null); private set
    private var seq = 0L

    fun run(id: String, text: String, mode: String) {
        if (running.containsKey(id)) return
        running = running + (id to mode)
        failure = null
        scope.launch {
            try {
                controller.setPolished(id, if (com.voxden.android.BuildConfig.DEBUG && DebugHooks.fakeCloud) DebugHooks.fakePolish(text, mode) else controller.polish(text, mode))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                failure = PolishFailure(id, error.message ?: "Polish didn't finish. Try again.", ++seq)
            } finally {
                running = running - id
            }
        }
    }

    fun clearFailure() { failure = null }
}

/** App icons for the "into WhatsApp" rows, loaded off the main thread and cached. */
object AppIcons {
    private val cache = LruCache<String, ImageBitmap>(96)
    private val missing = HashSet<String>()

    fun peek(packageName: String): ImageBitmap? = cache.get(packageName)

    suspend fun load(context: Context, packageName: String, sizePx: Int): ImageBitmap? {
        cache.get(packageName)?.let { return it }
        if (synchronized(missing) { packageName in missing }) return null
        val bitmap = withContext(Dispatchers.IO) {
            runCatching {
                val drawable = context.packageManager.getApplicationIcon(packageName)
                val out = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(out)
                drawable.setBounds(0, 0, sizePx, sizePx)
                drawable.draw(canvas)
                out.asImageBitmap()
            }.getOrNull()
        }
        if (bitmap != null) cache.put(packageName, bitmap) else synchronized(missing) { missing.add(packageName) }
        return bitmap
    }
}

/** The 16dp icon in a dictation's meta line: the target app's own icon, else a quiet stand-in. */
@Composable
fun TargetIcon(entry: HistoryEntry, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    val context = LocalContext.current
    val density = androidx.compose.ui.platform.LocalDensity.current
    val pkg = entry.appPackage
    // produceState keeps its last value when the key changes, so only trust it for the package it was loaded for.
    val loaded by produceState<ImageBitmap?>(initialValue = null, pkg) {
        value = pkg?.let { AppIcons.peek(it) ?: AppIcons.load(context, it, with(density) { (size * 3).roundToPx() }.coerceIn(48, 144)) }
    }
    val shape = RoundedCornerShape(size * 0.28f)
    val bitmap = if (pkg == null) null else (AppIcons.peek(pkg) ?: loaded)
    when {
        bitmap != null -> Image(bitmap, null, modifier.size(size).clip(shape))
        entry.source == DictationSource.FLOW_BAR && !entry.appLabel.isNullOrBlank() ->
            Box(modifier.size(size).clip(shape).background(Vox.hairline), contentAlignment = Alignment.Center) {
                Text(entry.appLabel.first().uppercase(), style = TextStyle(fontFamily = InterFamily, fontSize = (size.value * 0.58f).sp, color = Vox.text2))
            }
        entry.source == DictationSource.KEYBOARD -> Icon(Icons.Rounded.Keyboard, null, modifier.size(size), tint = Vox.text3)
        else -> Icon(Icons.Rounded.Mic, null, modifier.size(size), tint = Vox.text3)
    }
}

/** The current time, refreshed when the app resumes and at midnight, so "Today" groups never go stale. */
@Composable
fun rememberNow(): Long {
    var now by androidx.compose.runtime.remember { androidx.compose.runtime.mutableLongStateOf(System.currentTimeMillis()) }
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) { now = System.currentTimeMillis() }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        while (true) {
            val zone = java.time.ZoneId.systemDefault()
            val nextMidnight = java.time.LocalDate.now(zone).plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            kotlinx.coroutines.delay((nextMidnight - System.currentTimeMillis()).coerceIn(1_000L, 3_600_000L) + 500L)
            now = System.currentTimeMillis()
        }
    }
    return now
}
