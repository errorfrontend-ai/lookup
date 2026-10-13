package zm.lookup.device_services

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.io.File
import java.util.UUID

/**
 * Look Up's own Android services (P6 design §3.15), on the Android framework only: result notifications and the
 * recognition id their tap carries, the network's state, and which Dart engines of this process are attached.
 *
 * One instance per Flutter engine (the app's, and the background job's). The set of attached engines is one for the
 * whole process ([AttachedEngines]); an engine's ids leave it in [onDetachedFromEngine], when the engine is destroyed.
 *
 * Nothing here logs or keeps the words of a notification, a recognition id beyond its one delivery, or any file's
 * content.
 */
class DeviceServicesPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware,
    PluginRegistry.NewIntentListener {

    private lateinit var context: Context
    private lateinit var methods: MethodChannel
    private lateinit var networkEvents: EventChannel
    private lateinit var launchEvents: EventChannel
    private val mainThread = Handler(Looper.getMainLooper())

    /** The engine ids this engine registered, removed from the process's set when it is destroyed. */
    private val registeredEngineIds = mutableSetOf<String>()

    private var activityBinding: ActivityPluginBinding? = null
    private var launchSink: EventChannel.EventSink? = null

    /** A recognition id the activity was started with, until Dart takes it. */
    private var pendingLaunchRecognitionId: String? = null

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, "zm.lookup.device_services/methods")
        methods.setMethodCallHandler(this)
        networkEvents = EventChannel(binding.binaryMessenger, "zm.lookup.device_services/network")
        networkEvents.setStreamHandler(NetworkStreamHandler())
        launchEvents = EventChannel(binding.binaryMessenger, "zm.lookup.device_services/launches")
        launchEvents.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                launchSink = events
            }

            override fun onCancel(arguments: Any?) {
                launchSink = null
            }
        })
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        AttachedEngines.removeAll(registeredEngineIds)
        registeredEngineIds.clear()
        stopFollowingNetwork()
        methods.setMethodCallHandler(null)
        networkEvents.setStreamHandler(null)
        launchEvents.setStreamHandler(null)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "areNotificationsEnabled" -> result.success(notificationManager().areNotificationsEnabled())
                "showSavedClipNotification" -> {
                    showSavedClipNotification(call)
                    result.success(null)
                }
                "takeLaunchRecognitionId" -> {
                    result.success(pendingLaunchRecognitionId)
                    pendingLaunchRecognitionId = null
                }
                "isActiveNetworkMetered" -> result.success(connectivityManager().isActiveNetworkMetered)
                "isNetworkAvailable" -> result.success(isNetworkAvailable())
                "registerEngine" -> {
                    val engineId = call.argument<String>("engine_id")
                    if (engineId.isNullOrEmpty()) {
                        result.success(false)
                    } else {
                        registeredEngineIds.add(engineId)
                        AttachedEngines.add(engineId)
                        result.success(true)
                    }
                }
                "takeOverDeadLock" -> result.success(
                    AttachedEngines.takeOverDeadLock(
                        path = call.argument<String>("path") ?: "",
                        expectedContent = call.argument<String>("expected_content") ?: "",
                        askingEngineId = call.argument<String>("asking_engine_id") ?: "",
                        ownerEngineId = call.argument<String>("owner_engine_id"),
                    ),
                )
                else -> result.notImplemented()
            }
        } catch (error: Exception) {
            // Only the kind of failure travels; Dart answers as "not supported".
            result.error("DEVICE_SERVICES_FAILED", error.javaClass.simpleName, null)
        }
    }

    // ---- notifications ---------------------------------------------------------------------------------------

    private fun showSavedClipNotification(call: MethodCall) {
        val notificationId = call.argument<Int>("notification_id") ?: return
        val recognitionId = call.argument<String>("recognition_id") ?: return
        val title = call.argument<String>("title") ?: return
        val text = call.argument<String>("text") ?: return
        val manager = notificationManager()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                call.argument<String>("channel_name") ?: title,
                NotificationManager.IMPORTANCE_DEFAULT,
            )
            channel.description = call.argument<String>("channel_description") ?: ""
            manager.createNotificationChannel(channel)
        }
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        launch.putExtra(RECOGNITION_ID_EXTRA, recognitionId)
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // Its own request code per notification: two intents that differ only in their extras are one PendingIntent
        // to Android, so the older notification would otherwise open the newer result.
        val tap = PendingIntent.getActivity(
            context,
            notificationId,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        val notification = builder
            .setSmallIcon(notificationIcon())
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            // The words are generic (amendment A6), so the lock screen may show them as they are.
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()
        manager.notify(notificationId, notification)
    }

    private fun notificationIcon(): Int {
        val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
        return if (icon != 0) icon else context.applicationInfo.icon
    }

    private fun notificationManager() =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    // ---- the recognition id a notification's tap carries ------------------------------------------------------

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activityBinding = binding
        binding.addOnNewIntentListener(this)
        takeRecognitionIdFrom(binding.activity)
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        activityBinding?.removeOnNewIntentListener(this)
        activityBinding = null
    }

    override fun onNewIntent(intent: Intent): Boolean {
        val recognitionId = intent.getStringExtra(RECOGNITION_ID_EXTRA) ?: return false
        intent.removeExtra(RECOGNITION_ID_EXTRA)
        val sink = launchSink
        if (sink != null) sink.success(recognitionId) else pendingLaunchRecognitionId = recognitionId
        return false
    }

    private fun takeRecognitionIdFrom(activity: Activity) {
        val intent = activity.intent ?: return
        val recognitionId = intent.getStringExtra(RECOGNITION_ID_EXTRA) ?: return
        // Read once: the same intent comes back after a rotation, and must not open the result again.
        intent.removeExtra(RECOGNITION_ID_EXTRA)
        pendingLaunchRecognitionId = recognitionId
    }

    // ---- the network -------------------------------------------------------------------------------------------

    private fun connectivityManager() =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private fun isNetworkAvailable(): Boolean {
        val manager = connectivityManager()
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private inner class NetworkStreamHandler : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
            val sink = events ?: return
            stopFollowingNetwork()
            sink.success(isNetworkAvailable())
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    mainThread.post { sink.success(true) }
                }

                override fun onLost(network: Network) {
                    mainThread.post { sink.success(isNetworkAvailable()) }
                }
            }
            connectivityManager().registerDefaultNetworkCallback(callback)
            networkCallback = callback
        }

        override fun onCancel(arguments: Any?) = stopFollowingNetwork()
    }

    private fun stopFollowingNetwork() {
        val callback = networkCallback ?: return
        networkCallback = null
        try {
            connectivityManager().unregisterNetworkCallback(callback)
        } catch (error: IllegalArgumentException) {
            // Not registered any more: nothing to stop.
        }
    }

    companion object {
        /** The extra a result notification's intent carries: the recognition id it opens. */
        const val RECOGNITION_ID_EXTRA = "zm.lookup.recognition_id"

        /** The one channel, "Saved clip results" (P6 design §2.16). */
        const val CHANNEL_ID = "saved_clip_results"
    }
}

/**
 * The Dart engines of this process that are attached, by their ids (P6 design §3.8). One set for the whole process, so
 * every engine's lock judgement agrees, and every change and take-over runs under its one lock.
 */
object AttachedEngines {
    private val engineIds = mutableSetOf<String>()

    @Synchronized
    fun add(engineId: String) {
        engineIds.add(engineId)
    }

    @Synchronized
    fun removeAll(ids: Collection<String>) {
        engineIds.removeAll(ids.toSet())
    }

    /**
     * Removes the lock file at [path] when it still holds exactly [expectedContent] and its owner is gone: the engine
     * [ownerEngineId] is not attached, or, for a lock that names no owner, no engine but [askingEngineId] is. The
     * check and the removal happen under the one lock, so a lock an attached engine holds is never removed. The file
     * is renamed away first and deleted after, so a lock taken in between is never deleted.
     */
    @Synchronized
    fun takeOverDeadLock(path: String, expectedContent: String, askingEngineId: String, ownerEngineId: String?): Boolean {
        if (ownerEngineId != null) {
            if (engineIds.contains(ownerEngineId)) return false
        } else if (engineIds.any { it != askingEngineId }) {
            return false
        }
        val file = File(path)
        val content = try {
            file.readText()
        } catch (error: Exception) {
            return false
        }
        if (content != expectedContent) return false
        val removed = File("$path.taken-over-${UUID.randomUUID()}")
        if (!file.renameTo(removed)) return false
        removed.delete()
        return true
    }
}
