package cn.biandu.reader;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BianduFocus")
public class BianduFocusPlugin extends Plugin {
    private static final String PREFS = "biandu-focus";
    private static final String DND_OWNED = "dndOwned";
    private static final String PREVIOUS_FILTER = "previousFilter";
    private static final String FOCUS_REQUESTED = "focusRequested";
    private static boolean resumeFocusOnReturn = false;

    @PluginMethod
    public void enterFocusMode(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("无法读取当前 Activity。");
            return;
        }
        activity.runOnUiThread(() -> {
            activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(FOCUS_REQUESTED, true)
                .apply();
            setImmersive(activity, true);
            NotificationManager manager =
                (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
            boolean access = manager != null && manager.isNotificationPolicyAccessGranted();
            if (access) {
                enableDnd(activity, manager);
            }
            JSObject result = focusState(activity, manager);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void exitFocusMode(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("无法读取当前 Activity。");
            return;
        }
        activity.runOnUiThread(() -> {
            resumeFocusOnReturn = false;
            activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(FOCUS_REQUESTED)
                .apply();
            NotificationManager manager =
                (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
            restoreDnd(activity, manager);
            setImmersive(activity, false);
            call.resolve(focusState(activity, manager));
        });
    }

    @PluginMethod
    public void openDndSettings(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("无法读取当前 Activity。");
            return;
        }
        Intent intent = notificationPolicySettingsIntent(activity);
        activity.startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void getFocusState(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("无法读取当前 Activity。");
            return;
        }
        NotificationManager manager =
            (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        call.resolve(focusState(activity, manager));
    }

    private static JSObject focusState(Activity activity, NotificationManager manager) {
        SharedPreferences preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean access = manager != null && manager.isNotificationPolicyAccessGranted();
        boolean dndOwned = preferences.getBoolean(DND_OWNED, false);
        boolean focusRequested = preferences.getBoolean(FOCUS_REQUESTED, false);
        boolean dndActive = access && manager != null &&
            manager.getCurrentInterruptionFilter() == NotificationManager.INTERRUPTION_FILTER_PRIORITY;
        JSObject result = new JSObject();
        result.put("dndAccess", access);
        result.put("needsDndAccess", !access);
        result.put("dndActive", dndActive);
        result.put("dndOwned", dndOwned);
        result.put("focusRequested", focusRequested);
        return result;
    }

    private static void enableDnd(Activity activity, NotificationManager manager) {
        if (manager == null || !manager.isNotificationPolicyAccessGranted()) return;
        SharedPreferences preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.getBoolean(DND_OWNED, false)) {
            preferences.edit()
                .putBoolean(DND_OWNED, true)
                .putInt(PREVIOUS_FILTER, manager.getCurrentInterruptionFilter())
                .apply();
        }
        if (manager.getCurrentInterruptionFilter() != NotificationManager.INTERRUPTION_FILTER_PRIORITY) {
            manager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY);
        }
    }

    public static void releaseIfOwned(Activity activity) {
        if (activity == null) return;
        SharedPreferences preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        resumeFocusOnReturn = preferences.getBoolean(FOCUS_REQUESTED, false);
        NotificationManager manager =
            (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        restoreDnd(activity, manager);
        setImmersive(activity, false);
    }

    public static void resumeIfRequested(Activity activity) {
        if (activity == null || !resumeFocusOnReturn) return;
        resumeFocusOnReturn = false;
        SharedPreferences preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.getBoolean(FOCUS_REQUESTED, false)) return;
        setImmersive(activity, true);
        NotificationManager manager =
            (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        enableDnd(activity, manager);
    }

    private static Intent notificationPolicySettingsIntent(Activity activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Intent detail = new Intent(
                "android.settings.NOTIFICATION_POLICY_ACCESS_DETAIL_SETTINGS",
                Uri.parse("package:" + activity.getPackageName())
            );
            if (detail.resolveActivity(activity.getPackageManager()) != null) return detail;
        }
        return new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
    }

    private static void restoreDnd(Activity activity, NotificationManager manager) {
        SharedPreferences preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.getBoolean(DND_OWNED, false)) return;
        if (manager != null && manager.isNotificationPolicyAccessGranted()) {
            int previous = preferences.getInt(
                PREVIOUS_FILTER,
                NotificationManager.INTERRUPTION_FILTER_ALL
            );
            manager.setInterruptionFilter(previous);
        }
        preferences.edit().remove(DND_OWNED).remove(PREVIOUS_FILTER).apply();
    }

    private static void setImmersive(Activity activity, boolean enabled) {
        Window window = activity.getWindow();
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, window.getDecorView());
        WindowCompat.setDecorFitsSystemWindows(window, !enabled);
        if (enabled) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            );
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }
}
