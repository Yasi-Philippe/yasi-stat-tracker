package io.github.yasiphilippe.stattracker

import android.graphics.Color
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Custom plugins must be registered before the bridge is created in super.onCreate.
        registerPlugin(SecureKeyPlugin::class.java)
        // Edge-to-edge on every Android version (Android 15+ enforces it anyway), so the
        // SystemBars plugin handles insets the same way everywhere. Transparent bars with
        // light icons; SystemBars applies the configured style right after.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
    }
}
