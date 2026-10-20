package com.games.collection;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 发布包关闭 WebView 调试（debug 包仍可调试）
        boolean debuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) return;

        // 收紧 WebView 能力：只加载打包进 assets 的页面，不需要文件/内容访问
        WebSettings settings = webView.getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        // 下载页里的 APK 链接交给系统浏览器/下载器处理，WebView 自身不处理下载
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception ignored) {
                // 没有可用浏览器时保持页面不跳转
            }
        });
    }

    @Override
    public void onBackPressed() {
        // 侧滑/返回键：优先回退 WebView 历史（游戏页 → index），
        // 已在 index 无法回退时走 Capacitor 默认逻辑（再按一次退出）
        if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
            bridge.getWebView().goBack();
        } else {
            super.onBackPressed();
        }
    }
}
