package food.tche.smartpos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Casca Android do Tchê Food: uma WebView com o sistema web e as pontes nativas.
 *
 *  - Sem TCHEFOOD_APP_URL, o build web vai dentro do APK (assets/www) e é servido em
 *    https://appassets.androidplatform.net, uma origem https de verdade (IndexedDB,
 *    crypto.subtle e fetch funcionam como no navegador). Funciona sem internet.
 *  - Com TCHEFOOD_APP_URL, abre o sistema publicado nesse endereço https.
 *
 * A WebView só navega dentro da origem do app: qualquer outro link (WhatsApp, mapas,
 * consulta da NFC-e) abre fora, para as pontes de pagamento nunca ficarem expostas a
 * uma página de terceiros.
 */
public class MainActivity extends Activity {

    private static final int REQUEST_BLUETOOTH = 41;

    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);

        final AppOrigin origin = AppOrigin.fromBuildConfig();
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebAppPathHandler(getAssets()))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return origin.bundled ? assetLoader.shouldInterceptRequest(request.getUrl()) : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (origin.contains(url)) return false;
                openOutside(url);
                return true;
            }
        });

        NativeBridges.install(this, webView);
        requestBluetoothIfNeeded();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(origin.startUrl);
        }
    }

    private void openOutside(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException ignored) {
            // Sem app para abrir o link: fica na tela atual.
        }
    }

    private void requestBluetoothIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQUEST_BLUETOOTH);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    /** De onde o app carrega o sistema web. */
    static final class AppOrigin {
        static final String BUNDLED_HOST = "appassets.androidplatform.net";

        final boolean bundled;
        final String scheme;
        final String host;
        final int port;
        final String startUrl;

        private AppOrigin(boolean bundled, Uri start) {
            this.bundled = bundled;
            this.scheme = start.getScheme();
            this.host = start.getHost();
            this.port = start.getPort();
            this.startUrl = start.toString();
        }

        static AppOrigin fromBuildConfig() {
            String configured = BuildConfig.TCHEFOOD_APP_URL;
            if (configured == null || configured.isEmpty()) {
                return new AppOrigin(true, Uri.parse("https://" + BUNDLED_HOST + "/index.html"));
            }
            return new AppOrigin(false, Uri.parse(configured + "/"));
        }

        boolean contains(Uri url) {
            return "https".equals(url.getScheme())
                    && host != null && host.equalsIgnoreCase(url.getHost())
                    && port == url.getPort();
        }
    }
}
