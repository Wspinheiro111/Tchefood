package food.tche.smartpos;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;

import org.json.JSONException;
import org.json.JSONObject;

import br.com.uol.pagseguro.plugpagservice.wrapper.PlugPag;
import br.com.uol.pagseguro.plugpagservice.wrapper.PlugPagPaymentData;
import br.com.uol.pagseguro.plugpagservice.wrapper.PlugPagPrintResult;
import br.com.uol.pagseguro.plugpagservice.wrapper.PlugPagPrinterData;
import br.com.uol.pagseguro.plugpagservice.wrapper.PlugPagTransactionResult;

/**
 * Ponte JS -> PlugPag (PagBank Moderninha Smart / SmartPOS) do Tchê Food.
 * Regras portadas do app W9 Smart PagBank do Tchê Vendas (PlugPagProvider/PlugPagGateway):
 *
 *  - uma única instância de PlugPag por processo;
 *  - comandos bloqueantes serializados (synchronized);
 *  - isServiceBusy() verificado antes de cada operação;
 *  - a ponte devolve o resultado CRU do SDK. Quem decide aprovado / recusado /
 *    revisão manual é o front-end (src/lib/payments/terminalGuard.ts), com as
 *    mesmas regras do Tchê Vendas. Nada aqui inventa NSU, autorização ou valor;
 *  - exceção do SDK devolve {"result":-1,"errorCode":"WRAPPER_EXCEPTION"}, que o
 *    front-end trata como revisão manual (a cobrança pode ter passado);
 *  - nunca guarda nem expõe PAN, PIN ou CVV.
 *
 * Registrar na WebView:
 *   webView.addJavascriptInterface(PlugPagJsBridge.get(context), "PlugPagBridge");
 *
 * Dependência (settings.gradle: maven "https://raw.githubusercontent.com/pagseguro/PlugPagServiceWrapper/master"):
 *   implementation("br.com.uol.pagseguro.plugpagservice.wrapper:wrapper:1.35.0")
 */
public final class PlugPagJsBridge {

    private static volatile PlugPagJsBridge instance;

    /** Bobina de 58mm: 384 px úteis, 32 colunas. */
    private static final int PAPER_WIDTH_PX = 384;
    private static final int MAX_PRINT_QUALITY = 4;
    private static final int MIN_PRINTER_STEPS = 70;

    private final Context appContext;
    private final PlugPag plugPag;
    private final Object lock = new Object();

    private PlugPagJsBridge(Context context) {
        this.appContext = context.getApplicationContext();
        this.plugPag = new PlugPag(appContext);
    }

    /** Uma única instância de PlugPag por processo. */
    public static PlugPagJsBridge get(Context context) {
        PlugPagJsBridge current = instance;
        if (current != null) return current;
        synchronized (PlugPagJsBridge.class) {
            if (instance == null) instance = new PlugPagJsBridge(context);
            return instance;
        }
    }

    @JavascriptInterface
    public boolean isServiceBusy() {
        try {
            return plugPag.isServiceBusy();
        } catch (Exception e) {
            // Sem resposta do serviço: tratar como ocupado para não disparar cobrança às cegas.
            return true;
        }
    }

    /**
     * Entrada: {"type":1|2|5,"amount":centavos,"installmentType":1,"installments":1,"userReference":"TFXXXXXXXX"}
     * Saída: espelho de PlugPagTransactionResult (result, errorCode, message, transactionCode, transactionId,
     * hostNsu, autoCode, cardBrand, userReference, amount, terminalSerialNumber).
     */
    @JavascriptInterface
    public String doPayment(String json) {
        synchronized (lock) {
            try {
                JSONObject in = new JSONObject(json);
                int type = in.getInt("type");
                if (type != PlugPag.TYPE_CREDITO && type != PlugPag.TYPE_DEBITO && type != PlugPag.TYPE_PIX) {
                    return failure("INVALID_TYPE", "Forma de pagamento inválida");
                }
                int amount = in.getInt("amount");
                if (amount < 100) return failure("INVALID_AMOUNT", "Valor mínimo de R$ 1,00");
                int installments = in.optInt("installments", 1);
                if (type != PlugPag.TYPE_CREDITO && installments != 1) return failure("INVALID_INSTALLMENTS", "Parcelamento só no crédito");
                String userReference = in.getString("userReference");
                if (!userReference.matches("^[A-Za-z0-9]{1,10}$")) return failure("INVALID_REFERENCE", "Referência inválida");
                int installmentType = installments > 1 ? PlugPag.INSTALLMENT_TYPE_PARC_VENDEDOR : PlugPag.INSTALLMENT_TYPE_A_VISTA;

                if (plugPag.isServiceBusy()) return failure("SV03", "Serviço PlugPag ocupado");

                PlugPagTransactionResult r;
                try {
                    r = plugPag.doPayment(new PlugPagPaymentData(type, amount, installmentType, installments, userReference, true));
                } catch (Exception e) {
                    // A cobrança pode ter chegado ao autorizador antes da exceção.
                    return failure("WRAPPER_EXCEPTION", e.getMessage());
                }
                return toJson(r).toString();
            } catch (JSONException e) {
                return failure("INVALID_REQUEST", e.getMessage());
            }
        }
    }

    /** Última transação aprovada, para reconferir (pela userReference) uma cobrança que caiu no meio. */
    @JavascriptInterface
    public String getLastApprovedTransaction() {
        synchronized (lock) {
            try {
                if (plugPag.isServiceBusy()) return failure("RECOVERY_SERVICE_BUSY", "Serviço PlugPag ocupado");
                return toJson(plugPag.getLastApprovedTransaction()).toString();
            } catch (Exception e) {
                return failure("RECOVERY_WRAPPER_EXCEPTION", e.getMessage());
            }
        }
    }

    /** Impressão de texto puro na bobina (comprovante TEF / conferência). */
    @JavascriptInterface
    public String printText(String text) {
        synchronized (lock) {
            try {
                if (plugPag.isServiceBusy()) return printFailure("SERVICE_BUSY", "Serviço PlugPag ocupado");
                File png = renderTextToPng(text);
                try {
                    PlugPagPrintResult r = plugPag.printFromFile(new PlugPagPrinterData(png.getAbsolutePath(), MAX_PRINT_QUALITY, MIN_PRINTER_STEPS));
                    JSONObject out = new JSONObject();
                    out.put("success", r.getResult() == PlugPag.RET_OK);
                    out.put("errorCode", nullable(r.getErrorCode()));
                    out.put("message", nullable(r.getMessage()));
                    return out.toString();
                } finally {
                    //noinspection ResultOfMethodCallIgnored
                    png.delete();
                }
            } catch (Exception e) {
                // O papel pode ter saído antes da falha: o front-end não reimprime sozinho.
                return printFailure("WRAPPER_EXCEPTION", "A impressora pode ter impresso antes da falha. Confira o papel antes de reimprimir.");
            }
        }
    }

    /** Desenha o texto (32 colunas, monoespaçado) num PNG temporário do tamanho da bobina. */
    private File renderTextToPng(String text) throws Exception {
        String[] lines = (text == null ? "" : text).split("\n", -1);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK);
        paint.setTypeface(Typeface.MONOSPACE);
        // 32 colunas ocupando a largura útil.
        paint.setTextSize(PAPER_WIDTH_PX / 32f / 0.6f);
        Paint.FontMetrics fm = paint.getFontMetrics();
        int lineHeight = (int) Math.ceil(fm.descent - fm.ascent);
        Bitmap logo = loadBrandLogo();
        int logoHeight = logo == null ? 0 : logo.getHeight() + lineHeight;
        int height = Math.max(lineHeight, lines.length * lineHeight) + lineHeight + logoHeight;
        Bitmap bitmap = Bitmap.createBitmap(PAPER_WIDTH_PX, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);
        float y = -fm.ascent;
        for (String line : lines) {
            canvas.drawText(line, 0, y, paint);
            y += lineHeight;
        }
        if (logo != null) {
            // Logo oficial do Tchê Food centralizada ao final do cupom.
            float top = y - (-fm.ascent) + lineHeight;
            canvas.drawBitmap(logo, Math.max(0, (PAPER_WIDTH_PX - logo.getWidth()) / 2f), top, null);
            logo.recycle();
        }
        File file = File.createTempFile("tchefood-print-", ".png", appContext.getCacheDir());
        try (FileOutputStream out = new FileOutputStream(file)) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        } finally {
            bitmap.recycle();
        }
        return file;
    }

    /**
     * Logo em 1 bit (assets/tchefood-logo-print.png, 360 px de largura). Se o asset faltar
     * ou não abrir, imprime só o texto: a logo nunca impede o comprovante.
     */
    private Bitmap loadBrandLogo() {
        try (java.io.InputStream in = appContext.getAssets().open("tchefood-logo-print.png")) {
            Bitmap raw = BitmapFactory.decodeStream(in);
            if (raw == null) return null;
            if (raw.getWidth() <= PAPER_WIDTH_PX) return raw;
            int h = Math.round(raw.getHeight() * (PAPER_WIDTH_PX / (float) raw.getWidth()));
            Bitmap scaled = Bitmap.createScaledBitmap(raw, PAPER_WIDTH_PX, h, false);
            raw.recycle();
            return scaled;
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONObject toJson(PlugPagTransactionResult r) {
        JSONObject out = new JSONObject();
        try {
            out.put("result", r.getResult());
            out.put("errorCode", nullable(r.getErrorCode()));
            out.put("message", nullable(r.getMessage()));
            out.put("transactionCode", nullable(r.getTransactionCode()));
            out.put("transactionId", nullable(r.getTransactionId()));
            out.put("hostNsu", nullable(r.getHostNsu()));
            out.put("autoCode", nullable(r.getAutoCode()));
            out.put("cardBrand", nullable(r.getCardBrand()));
            out.put("userReference", nullable(r.getUserReference()));
            out.put("amount", nullable(r.getAmount()));
            out.put("terminalSerialNumber", nullable(r.getTerminalSerialNumber()));
        } catch (JSONException ignored) {
            // put(String, Object) só falha com chave nula.
        }
        return out;
    }

    private static Object nullable(String value) {
        return value == null ? JSONObject.NULL : value;
    }

    private static String failure(String code, String message) {
        JSONObject out = new JSONObject();
        try {
            out.put("result", -1);
            out.put("errorCode", code);
            out.put("message", message == null ? JSONObject.NULL : message);
        } catch (JSONException ignored) {
        }
        return out.toString();
    }

    private static String printFailure(String code, String message) {
        JSONObject out = new JSONObject();
        try {
            out.put("success", false);
            out.put("errorCode", code);
            out.put("message", message);
        } catch (JSONException ignored) {
        }
        return out.toString();
    }
}
