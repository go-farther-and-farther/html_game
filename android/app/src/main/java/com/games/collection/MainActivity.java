package com.games.collection;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

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
