package food.tche.smartpos;

import android.content.Context;
import android.webkit.WebView;

/** APK PagBank: impressoras externas + PlugPag (cobrança e bobina dentro da maquininha). */
final class NativeBridges {

    private NativeBridges() {
    }

    static void install(Context context, WebView webView) {
        webView.addJavascriptInterface(new ExternalPrinterBridge(new SmartPosJsBridge()), "SmartPosNative");
        webView.addJavascriptInterface(PlugPagJsBridge.get(context), "PlugPagBridge");
    }
}
