package com.voxden.android.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class WavEncoderTest {
    @Test fun oneSecondOfAudioHasValidPcmHeaderAndPayload() {
        val pcm = ByteArray(32_000) { (it % 127).toByte() }
        val wav = WavEncoder.encode(pcm)
        val header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals(wav.size - 8, header.getInt(4))
        assertEquals("WAVE", String(wav, 8, 4))
        assertEquals(1, header.getShort(20).toInt())
        assertEquals(1, header.getShort(22).toInt())
        assertEquals(16_000, header.getInt(24))
        assertEquals(32_000, header.getInt(28))
        assertEquals(16, header.getShort(34).toInt())
        assertEquals(pcm.size, header.getInt(40))
        assertArrayEquals(pcm, wav.copyOfRange(44, wav.size))
    }
    @Test(expected = IllegalArgumentException::class)
    fun rejectsHalfSamples() { WavEncoder.encode(byteArrayOf(1)) }
    @Test fun fourMinuteMaximumFitsCloudRequestLimitAfterBase64() {
        val wav = WavEncoder.encode(ByteArray(240 * 16_000 * 2))
        val base64Bytes = 4 * ((wav.size + 2) / 3)
        org.junit.Assert.assertTrue(base64Bytes + 32_000 < 12 * 1024 * 1024)
    }
}
