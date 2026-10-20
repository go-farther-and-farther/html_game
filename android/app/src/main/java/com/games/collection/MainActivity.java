package com.games.collection;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) return;

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
