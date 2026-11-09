package food.tche.smartpos;

import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * Serve o build do Vite guardado em assets/www. O index.html do Vite usa caminhos
 * absolutos (/assets/...), por isso a raiz da origem aponta para www/. Caminho sem
 * extensão que não existe devolve o index.html (rotas da SPA).
 */
final class WebAppPathHandler implements WebViewAssetLoader.PathHandler {

    private static final String ROOT = "www/";

    private final AssetManager assets;

    WebAppPathHandler(AssetManager assets) {
        this.assets = assets;
    }

    @Nullable
    @Override
    public WebResourceResponse handle(@NonNull String path) {
        String clean = path.startsWith("/") ? path.substring(1) : path;
        if (clean.isEmpty()) clean = "index.html";
        if (clean.contains("..")) return null;

        InputStream in = open(ROOT + clean);
        if (in == null && !lastSegment(clean).contains(".")) {
            clean = "index.html";
            in = open(ROOT + clean);
        }
        if (in == null) return null;
        return new WebResourceResponse(mimeType(clean), "utf-8", in);
    }

    @Nullable
    private InputStream open(String assetPath) {
        try {
            return assets.open(assetPath);
        } catch (IOException e) {
            return null;
        }
    }

    private static String lastSegment(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? path : path.substring(slash + 1);
    }

    static String mimeType(String path) {
        String name = path.toLowerCase(Locale.ROOT);
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".webmanifest")) return "application/manifest+json";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".ico")) return "image/x-icon";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".woff")) return "font/woff";
        if (name.endsWith(".glb")) return "model/gltf-binary";
        if (name.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
