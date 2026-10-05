package com.voxden.android

import android.app.Application
import com.voxden.android.core.CrashLog

/** Starts the crash recorder before anything else in the app runs. */
class VoxdenApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
    }
}
