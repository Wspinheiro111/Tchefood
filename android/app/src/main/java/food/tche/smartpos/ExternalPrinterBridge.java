package food.tche.smartpos;

import android.webkit.JavascriptInterface;

/**
 * Expõe como window.SmartPosNative só as impressoras externas (rede e Bluetooth).
 *
 * Fica de fora o printInternalEscPos de propósito: sem ele, o front-end
 * (printDocument em src/lib/payments/drivers.ts) imprime a bobina da PagBank pelo
 * PlugPagBridge.printText em vez de falhar em "Impressora interna indisponível".
 */
public final class ExternalPrinterBridge {

    private final SmartPosJsBridge delegate;

    public ExternalPrinterBridge(SmartPosJsBridge delegate) {
        this.delegate = delegate;
    }

    @JavascriptInterface
    public String printNetworkEscPos(String ipAddress, int port, String base64Bytes) {
        return delegate.printNetworkEscPos(ipAddress, port, base64Bytes);
    }

    @JavascriptInterface
    public String printBluetoothEscPos(String macAddress, String base64Bytes) {
        return delegate.printBluetoothEscPos(macAddress, base64Bytes);
    }
}
