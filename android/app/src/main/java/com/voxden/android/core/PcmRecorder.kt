package com.voxden.android.core

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.sqrt

internal object WavEncoder {
    fun encode(pcm: ByteArray, sampleRate: Int = 16_000): ByteArray {
        require(pcm.size % 2 == 0) { "PCM data must contain complete 16-bit samples." }
        return ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVEfmt ".toByteArray())
            putInt(16); putShort(1); putShort(1); putInt(sampleRate); putInt(sampleRate * 2)
            putShort(2); putShort(16); put("data".toByteArray()); putInt(pcm.size); put(pcm)
        }.array()
    }
}

/** Memory-only capture. Four minutes stays below the server's 12 MiB base64 JSON limit. */
internal class PcmRecorder(private val scope: CoroutineScope, private val onAudioLevel: (Float) -> Unit = {}) {
    @Volatile private var recording = false
    private var recorder: AudioRecord? = null
    private var capture: Deferred<ByteArray>? = null

    @SuppressLint("MissingPermission")
    fun start() {
        check(!recording) { "A recording is already running." }
        val minimum = AudioRecord.getMinBufferSize(16_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "This device cannot record 16 kHz audio." }
        val bufferSize = maxOf(minimum, 6400)
        val audio = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16_000,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
        if (audio.state != AudioRecord.STATE_INITIALIZED) {
            audio.release()
            error("The microphone could not be initialized.")
        }
        try { audio.startRecording() } catch (error: Exception) { audio.release(); throw error }
        recorder = audio
        recording = true
        capture = scope.async(Dispatchers.IO) {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(bufferSize)
            try {
                while (recording && output.size() < MAX_PCM_BYTES) {
                    val count = audio.read(buffer, 0, minOf(buffer.size, MAX_PCM_BYTES - output.size()))
                    if (count < 0 && recording) error("Microphone recording was interrupted. Try again.")
                    if (count > 0) {
                        output.write(buffer, 0, count)
                        var squared = 0.0
                        var samples = 0
                        for (i in 0 until count - 1 step 2) {
                            val sample = ((buffer[i].toInt() and 0xff) or (buffer[i + 1].toInt() shl 8)).toShort().toDouble()
                            squared += sample * sample
                            samples++
                        }
                        if (samples > 0) {
                            val rms = sqrt(squared / samples) / 32768.0
                            val db = 20 * log10(maxOf(rms, 0.000001))
                            onAudioLevel(((db + 60) / 60).toFloat().coerceIn(0f, 1f))
                        }
                    }
                    if (count == 0) Thread.yield()
                }
                WavEncoder.encode(output.toByteArray())
            } finally {
                recording = false
                runCatching { audio.stop() }
                audio.release()
            }
        }
    }

    suspend fun finish(): ByteArray {
        recording = false
        runCatching { recorder?.stop() }
        return try { capture?.await() ?: ByteArray(0) } finally { recorder = null; capture = null }
    }

    companion object { const val MAX_SECONDS = 240; private const val MAX_PCM_BYTES = 16_000 * 2 * MAX_SECONDS }
}
