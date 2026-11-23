package com.experiment.magneticrush;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 沉浸式全屏壳：进入游戏即隐藏状态栏与导航栏（sticky immersive）。
 *
 * 从屏幕边缘下拉时系统栏会临时浮现，几秒后自动隐藏，而不是永久消失。
 * 统一使用 WindowInsetsControllerCompat（内部按 API 版本分发），
 * 不直接调用已废弃的 SYSTEM_UI_FLAG_*，可覆盖 minSdk 24 ~ targetSdk 36。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // manifest 已锁 sensorLandscape；这里再显式请求一次，
        // 覆盖部分 ROM 在“系统自动旋转关闭”时忽略 manifest、仍停留在竖屏的情况
        ensureLandscape();
        applyImmersiveMode();
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从后台切回、退出分屏/小窗时重新确认横屏
        ensureLandscape();
        // 从后台切回、分屏返回时系统栏会"复活"，这里重新隐藏
        applyImmersiveMode();
    }

    /**
     * 仅在当前不是横屏时请求一次 sensorLandscape（左右横屏都允许）。
     * 不做无条件调用，避免每次 onResume 都触发一次配置变更；
     * 旋转本身由 manifest 的 configChanges 接住，不会重建 Activity。
     */
    private void ensureLandscape() {
        Configuration config = getResources().getConfiguration();
        if (config.orientation == Configuration.ORIENTATION_LANDSCAPE) return;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 下拉通知栏、权限弹窗、输入法收起后重新获得焦点，也要恢复隐藏
        if (hasFocus) applyImmersiveMode();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // manifest 已声明 configChanges，旋转不会重建 Activity，需手动重新应用
        applyImmersiveMode();
    }

    private void applyImmersiveMode() {
        Window window = getWindow();
        if (window == null) return;

        // 内容延伸到系统栏区域（targetSdk 35+ 默认强制 edge-to-edge，这里显式声明保持同一口径）
        WindowCompat.setDecorFitsSystemWindows(window, false);

        // 允许绘制到刘海区域（API 28+），避免横屏时左侧被裁成黑边或挤压布局
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams params = window.getAttributes();
            params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(params);
        }

        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller == null) return;

        // sticky：隐藏系统栏；用户下拉时临时显示，超时后自动隐藏
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
}
