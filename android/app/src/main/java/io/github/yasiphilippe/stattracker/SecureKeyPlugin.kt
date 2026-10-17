package io.github.yasiphilippe.stattracker

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Logger
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * Small secrets (base64url strings) sealed with an AES-256-GCM key that never leaves the
 * Android Keystore. Each value is stored in the private SharedPreferences file `trazo_secure`
 * as Base64(iv || ciphertext+tag), with the entry name as associated data, so a value cannot
 * be moved to another name.
 *
 * If the key becomes unusable (invalidated, lost, keystore reset), the values it sealed are
 * unrecoverable: they are deleted and `get` resolves `{ value: null }`.
 *
 * JS contract: get({name}) -> {value: string|null}; set({name, value}); remove({name}).
 */
@CapacitorPlugin(name = "SecureKey")
class SecureKeyPlugin : Plugin() {

    private val prefs: SharedPreferences by lazy {
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
    }

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val name = validName(call) ?: return
        onWorker(call) {
            val value = read(name)
            call.resolve(JSObject().put("value", value ?: JSONObject.NULL))
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val name = validName(call) ?: return
        val value = call.getString("value")
        if (value == null || !VALUE_PATTERN.matches(value)) {
            call.reject("value must be a base64url string", "INVALID_VALUE")
            return
        }
        onWorker(call) {
            write(name, value)
            call.resolve()
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val name = validName(call) ?: return
        onWorker(call) {
            commit(prefs.edit().remove(name))
            call.resolve()
        }
    }

    private fun validName(call: PluginCall): String? {
        val name = call.getString("name")
        if (name == null || !NAME_PATTERN.matches(name)) {
            call.reject("name must match [A-Za-z0-9:_-]{1,64}", "INVALID_NAME")
            return null
        }
        return name
    }

    /** Keystore work can take a while: keep it off the shared plugin thread, one call at a time. */
    private fun onWorker(call: PluginCall, work: () -> Unit) {
        worker.execute {
            try {
                work()
            } catch (e: Exception) {
                Logger.error(TAG, "Operation failed: ${e.javaClass.simpleName}", null)
                call.reject("Secure storage failed (${e.javaClass.simpleName})", "UNAVAILABLE")
            }
        }
    }

    private fun read(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        val blob = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            null
        }
        if (blob == null || blob.size < IV_BYTES + TAG_BYTES) {
            commit(prefs.edit().remove(name))
            return null
        }
        return try {
            val key = loadKey()
            if (key == null) {
                // The key is gone, so nothing stored can be decrypted any more.
                discardKeyAndValues()
                return null
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, blob, 0, IV_BYTES))
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(blob, IV_BYTES, blob.size - IV_BYTES), Charsets.UTF_8)
        } catch (e: AEADBadTagException) {
            // Sealed by another key, or altered on disk.
            commit(prefs.edit().remove(name))
            null
        } catch (e: Exception) {
            if (!isUnusableKey(e)) throw e
            discardKeyAndValues()
            null
        }
    }

    private fun write(name: String, value: String) {
        val blob = try {
            seal(loadKey() ?: newKey(), name, value)
        } catch (e: Exception) {
            if (!isUnusableKey(e)) throw e
            // Whatever the old key sealed is unreadable now; start over with a fresh key.
            discardKeyAndValues()
            seal(newKey(), name, value)
        }
        commit(prefs.edit().putString(name, Base64.encodeToString(blob, Base64.NO_WRAP)))
    }

    private fun seal(key: SecretKey, name: String, value: String): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key) // randomized encryption: the Keystore picks the IV
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "Unexpected IV size" }
        return iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    }

    /** The device key, or null if there is none. Throws if it exists but cannot be loaded. */
    private fun loadKey(): SecretKey? = keyStore.getKey(KEY_ALIAS, null) as? SecretKey

    /** Creates the device key. Values left over from a previous key could never be read: drop them. */
    private fun newKey(): SecretKey {
        commit(prefs.edit().clear())
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false)
            .build()
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(spec)
        return generator.generateKey()
    }

    private fun discardKeyAndValues() {
        try {
            keyStore.deleteEntry(KEY_ALIAS)
        } catch (e: Exception) {
            Logger.warn(TAG, "Could not delete key: ${e.javaClass.simpleName}")
        }
        commit(prefs.edit().clear())
    }

    /**
     * True when the key itself can no longer be used (permanently invalidated, unloadable or
     * rejected by the Keystore). Transient Keystore failures are not treated as such, so a
     * busy Keystore never costs the user their stored secrets.
     */
    private fun isUnusableKey(e: Exception): Boolean {
        if (e is UnrecoverableKeyException) return true
        if (e !is InvalidKeyException) return false // includes KeyPermanentlyInvalidatedException
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val cause = e.cause
            if (cause is android.security.KeyStoreException && cause.isTransientFailure) return false
        }
        return true
    }

    private fun commit(editor: SharedPreferences.Editor) {
        check(editor.commit()) { "Could not write $PREFS_FILE" }
    }

    companion object {
        private const val TAG = "SecureKey"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "trazo_device_key"
        private const val PREFS_FILE = "trazo_secure"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BYTES = 16
        private val NAME_PATTERN = Regex("[A-Za-z0-9:_-]{1,64}")
        private val VALUE_PATTERN = Regex("[A-Za-z0-9_-]{0,16384}={0,2}")

        /** One thread for the whole process: Keystore and preference updates never interleave. */
        private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "SecureKey").apply { isDaemon = true }
        }
    }
}
