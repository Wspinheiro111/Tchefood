package food.tche.smartpos;

import android.content.Context;
import android.webkit.WebView;

/**
 * APK de celular/tablet: só impressoras externas. Sem PlugPag, a cobrança vai pela
 * nuvem (Stone Connect, Mercado Pago Point) ou cai no simulador.
 */
final class NativeBridges {

    private NativeBridges() {
    }

    static void install(Context context, WebView webView) {
        webView.addJavascriptInterface(new ExternalPrinterBridge(new SmartPosJsBridge()), "SmartPosNative");
    }
}
