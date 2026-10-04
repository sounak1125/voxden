package com.voxden.android.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Account session, transcripts, and dictionary are encrypted with a non-exportable device key. */
internal class SecureStore(context: Context) {
    private val preferences = context.getSharedPreferences("voxden_private", Context.MODE_PRIVATE)
    private val keyAlias = "voxden.android.storage.v1"
    var readFailed = false
        private set

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    fun read(): JSONObject {
        val packed = preferences.getString("payload", null) ?: return JSONObject()
        return try {
            val bytes = Base64.decode(packed, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        } catch (_: Exception) {
            readFailed = true
            JSONObject()
        }
    }

    fun write(state: AppState, token: String?) {
        val json = JSONObject().put("provider", state.provider.name).put("language", state.language)
            .put("consent", state.cloudConsent).put("saveHistory", state.saveHistory)
            .put("onboarded", state.onboarded)
            .put("freeWords", JSONObject().put("periodStart", state.freeWords.periodStart).put("used", state.freeWords.used))
            .put("flowBar", JSONObject().put("side", state.flowBar.side.name).put("offset", state.flowBar.offset.toDouble())
                .put("alwaysShow", state.flowBar.alwaysShow).put("haptics", state.flowBar.haptics))
            .put("token", token ?: JSONObject.NULL).put("dictionary", JSONArray(state.dictionary))
            .put("history", JSONArray(state.history.take(AppController.HISTORY_LIMIT).map {
                JSONObject().put("id", it.id).put("text", it.text).put("createdAt", it.createdAt).put("provider", it.provider)
                    .put("source", it.source.name).put("appPackage", it.appPackage ?: "").put("appLabel", it.appLabel ?: "")
                    .put("polished", it.polished ?: "").put("durationSeconds", it.durationSeconds)
            }))
        state.account?.let { json.put("account", JSONObject().put("email", it.email).put("plan", it.plan)
            .put("cloud", JSONObject().put("creditsUsed", it.creditsUsed).put("creditsCap", it.creditsCap))
            .put("trial", JSONObject().put("credits", it.trial.credits).put("used", it.trial.used).put("available", it.trial.available))) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val packed = cipher.iv + cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        check(preferences.edit().putString("payload", Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) { "Device storage is full. Changes could not be saved." }
    }
}
