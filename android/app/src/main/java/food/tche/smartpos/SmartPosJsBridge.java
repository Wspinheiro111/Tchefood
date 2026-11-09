package food.tche.smartpos;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.UUID;

/**
 * Ponte JS -> Android do Tchê Food. Registrar na WebView com:
 *   webView.addJavascriptInterface(new SmartPosJsBridge(printer), "SmartPosNative");
 *
 * O front-end (src/services/printer/printerService.ts) chama:
 *   window.SmartPosNative.printNetworkEscPos(ip, 9100, base64)
 *   window.SmartPosNative.printBluetoothEscPos(mac, base64)
 *   window.SmartPosNative.printInternalEscPos(base64)
 * Todos devolvem JSON {"success":true} ou {"success":false,"error":"..."}.
 *
 * Permissões no AndroidManifest.xml: INTERNET, BLUETOOTH_CONNECT (Android 12+),
 * BLUETOOTH / BLUETOOTH_ADMIN (Android 11 ou inferior).
 */
public class SmartPosJsBridge {

    /** UUID SPP (Serial Port Profile) usado pelas impressoras térmicas Bluetooth. */
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private final InternalPrinter internalPrinter;

    /** Abstração da bobina interna (Stone printer provider / PagBank PlugPag). */
    public interface InternalPrinter {
        void printRaw(byte[] escPos) throws Exception;
    }

    public SmartPosJsBridge() {
        this(null);
    }

    public SmartPosJsBridge(InternalPrinter internalPrinter) {
        this.internalPrinter = internalPrinter;
    }

    private static String ok() {
        return "{\"success\":true}";
    }

    private static String error(Exception e) {
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        return "{\"success\":false,\"error\":\"" + msg.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
    }

    /** 1. Impressão direta via rede Wi-Fi / cabo (qualquer marca, 58mm ou 80mm, porta 9100). */
    @JavascriptInterface
    public String printNetworkEscPos(String ipAddress, int port, String base64Bytes) {
        byte[] data = Base64.decode(base64Bytes, Base64.DEFAULT);
        try (Socket socket = new Socket()) {
            // Timeout de 3s para não travar a tela do garçom se a impressora estiver desligada.
            socket.connect(new InetSocketAddress(ipAddress, port), 3000);
            socket.setSoTimeout(3000);
            OutputStream out = socket.getOutputStream();
            out.write(data);
            out.flush();
            return ok();
        } catch (Exception e) {
            return error(e);
        }
    }

    /** 2. Impressão direta via Bluetooth SPP (mini impressoras 58mm e 80mm). */
    @JavascriptInterface
    public String printBluetoothEscPos(String macAddress, String base64Bytes) {
        byte[] data = Base64.decode(base64Bytes, Base64.DEFAULT);
        BluetoothSocket socket = null;
        try {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter == null || !adapter.isEnabled()) throw new IllegalStateException("Bluetooth desligado");
            adapter.cancelDiscovery();
            BluetoothDevice device = adapter.getRemoteDevice(macAddress);
            socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
            socket.connect();
            OutputStream out = socket.getOutputStream();
            out.write(data);
            out.flush();
            Thread.sleep(300); // dá tempo do buffer da impressora esvaziar antes de fechar
            return ok();
        } catch (Exception e) {
            return error(e);
        } finally {
            if (socket != null) {
                try { socket.close(); } catch (Exception ignored) { }
            }
        }
    }

    /** 3. Bobina interna da SmartPOS (Stone / PagBank Moderninha Smart), 58mm. */
    @JavascriptInterface
    public String printInternalEscPos(String base64Bytes) {
        try {
            if (internalPrinter == null) throw new IllegalStateException("Impressora interna indisponível");
            internalPrinter.printRaw(Base64.decode(base64Bytes, Base64.DEFAULT));
            return ok();
        } catch (Exception e) {
            return error(e);
        }
    }
}
