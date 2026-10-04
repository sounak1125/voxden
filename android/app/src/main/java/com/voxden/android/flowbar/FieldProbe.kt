package com.voxden.android.flowbar

import android.accessibilityservice.AccessibilityService
import android.content.pm.PackageManager
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.voxden.android.core.TargetApp

/** Hands a node back to the framework's pool (a no-op since Android 13). */
@Suppress("DEPRECATION")
internal fun AccessibilityNodeInfo?.release() { this?.recycle() }

@Suppress("DEPRECATION")
private fun AccessibilityWindowInfo?.release() { this?.recycle() }

/** The text field that had input focus when it was probed. Enough to tell it from another one later. */
internal data class FieldIdentity(val packageName: String?, val viewId: String?, val className: String?)

/**
 * Looks at the screen through the accessibility windows API: is the keyboard up, is the input-focused
 * node editable, and is it a password field. Reads nothing but those facts: never the text of a field,
 * except through [TextTyper] while a dictation is being typed.
 */
internal class FieldProbe(private val service: AccessibilityService) {

    /** One look at the screen. */
    fun snapshot(): FieldSnapshot {
        val windows = try { service.windows } catch (_: Exception) { emptyList<AccessibilityWindowInfo>() }
        var ime: Box? = null
        try {
            for (window in windows) {
                if (window.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue
                val bounds = Rect()
                window.getBoundsInScreen(bounds)
                if (!bounds.isEmpty && ime == null) ime = Box(bounds.left, bounds.top, bounds.right, bounds.bottom)
            }
            val node = focusedInput(windows)
            try {
                if (node == null) return FieldSnapshot(imeBounds = ime)
                return FieldSnapshot(
                    imeBounds = ime,
                    editableFocused = node.isEditable,
                    password = isPassword(node),
                    packageName = node.packageName?.toString()
                )
            } finally { node.release() }
        } finally { windows.forEach { it.release() } }
    }

    /** The node with input focus, or null. The caller releases it. */
    fun focusedInput(): AccessibilityNodeInfo? {
        val windows = try { service.windows } catch (_: Exception) { emptyList<AccessibilityWindowInfo>() }
        return try { focusedInput(windows) } finally { windows.forEach { it.release() } }
    }

    private fun focusedInput(windows: List<AccessibilityWindowInfo>): AccessibilityNodeInfo? {
        for (window in windows) {
            if (!window.isFocused || window.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val root = window.root ?: continue
            val found = try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } finally { root.release() }
            if (found != null) return found
        }
        return try { service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } catch (_: Exception) { null }
    }

    fun isPassword(node: AccessibilityNodeInfo): Boolean = node.isPassword || isPasswordInputType(node.inputType)

    fun identity(node: AccessibilityNodeInfo) =
        FieldIdentity(node.packageName?.toString(), node.viewIdResourceName, node.className?.toString())

    /** The app a dictation will be typed into: the focused field's app, else the app in front. */
    fun targetApp(): TargetApp? {
        val node = focusedInput()
        var packageName: String? = node?.packageName?.toString()
        node.release()
        if (packageName == null) {
            val root = service.rootInActiveWindow
            packageName = root?.packageName?.toString()
            root.release()
        }
        return packageName?.let { TargetApp(it, appLabel(it)) }
    }

    fun appLabel(packageName: String): String = try {
        val manager = service.packageManager
        manager.getApplicationLabel(manager.getApplicationInfo(packageName, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        packageName.substringAfterLast('.').replaceFirstChar { it.uppercase() }
    } catch (_: SecurityException) {
        packageName.substringAfterLast('.').replaceFirstChar { it.uppercase() }
    }
}
