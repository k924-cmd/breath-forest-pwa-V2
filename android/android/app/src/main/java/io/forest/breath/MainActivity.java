package io.forest.breath;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.WebViewListener;

import java.util.ArrayList;

public class MainActivity extends BridgeActivity {

    /** 后端地址（构建时由 android/build.js 替换成真实 IP:端口，如 http://1.2.3.4:8080） */
    private static final String API_BASE = "http://__API_BASE__/v1";

    /** 与前端 index.html 的 APP_VERSION 保持一致，构建时替换 */
    private static final String APP_VERSION = "__APP_VERSION__";

    private static final String JS_INJECT =
            ";(function(){try{" +
                    "window.__API_BASE__='" + API_BASE + "';" +
                    "window.__ANDROID_APP__=true;" +
                    "window.__ANDROID_VERSION__='" + APP_VERSION + "';" +
                    "}catch(e){}})();";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugins(new ArrayList<Class<? extends Plugin>>());
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                inject();
            }

            @Override
            public void onPageLoaded(WebView webView) {
                inject();
            }
        });
        super.onCreate(savedInstanceState);
    }

    private void inject() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.evaluateJavascript(JS_INJECT, null);
        }
    }
}
