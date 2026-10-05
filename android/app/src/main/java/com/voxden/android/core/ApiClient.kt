package com.voxden.android.core

import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** [code] is the account service's machine-readable reason (`country`, `subscription`, ...), when it sent one. */
class ApiException(val status: Int, message: String, val code: String? = null) : Exception(message)

/** Never redirects bearer tokens, logs payloads, or accepts a cleartext endpoint. */
class ApiClient(private val baseUrl: String = "https://account.voxden.app/v1") {
    suspend fun request(method: String, path: String, token: String? = null, body: JSONObject? = null): JSONObject = suspendCancellableCoroutine { continuation ->
        require(baseUrl.startsWith("https://")) { "Voxden Cloud requires HTTPS." }
        val active = AtomicReference<HttpURLConnection?>()
        val future = workers.submit {
          try {
            if (!continuation.isActive) return@submit
            val connection = URL(baseUrl + path).openConnection() as HttpURLConnection
            active.set(connection)
            if (!continuation.isActive) return@submit
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 20_000
            connection.readTimeout = 120_000
            connection.setRequestProperty("Accept", "application/json")
            if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val result = runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
            if (status !in 200..299) throw ApiException(
                status, result.optString("error").ifBlank { "Voxden Cloud could not complete the request (HTTP $status)." },
                result.optString("code").ifBlank { null }
            )
            continuation.resume(result)
          } catch (error: Exception) {
            continuation.resumeWithException(error)
          } finally {
            active.getAndSet(null)?.disconnect()
          }
        }
        continuation.invokeOnCancellation {
            // Closing the socket also tells the relay to cancel its upstream transcription.
            active.getAndSet(null)?.disconnect()
            future.cancel(true)
        }
    }
    companion object { private val workers = Executors.newFixedThreadPool(3) }
}
