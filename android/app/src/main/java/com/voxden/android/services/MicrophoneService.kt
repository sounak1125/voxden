package com.voxden.android.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.voxden.android.core.AppController
import com.voxden.android.core.RecordingPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** Started only by a visible recording screen, never by a boot receiver or the idle dock. */
class MicrophoneService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Voice recording", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 21, Intent(this, RecordingActivity::class.java).setAction(RecordingActivity.RESUME), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 22, Intent(this, MicrophoneService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Voxden dictation")
            .setContentText("Microphone active while you record")
            .setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build()).build()
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(202, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(202, notification)
        } catch (_: Exception) {
            AppController.get(this).cancelRecording()
            AppController.get(this).reportError("Android could not open the microphone service. Keep Voxden visible and try again.")
            stopSelf()
            return
        }
        scope.launch {
            AppController.get(this@MicrophoneService).state.collect { state ->
                // startRecording is synchronous; this service is created on the next main-loop pass.
                if (state.phase != RecordingPhase.RECORDING) stopSelf()
            }
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            AppController.get(this).stopRecording()
            stopSelf()
        }
        return START_NOT_STICKY
    }
    override fun onTaskRemoved(rootIntent: Intent?) {
        AppController.get(this).cancelRecording()
        stopSelf()
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object {
        private const val CHANNEL = "voxden_recording"
        private const val STOP = "com.voxden.android.STOP_RECORDING"
        fun start(context: Context) { context.startForegroundService(Intent(context, MicrophoneService::class.java)) }
        fun stop(context: Context) { context.stopService(Intent(context, MicrophoneService::class.java)) }
    }
}
