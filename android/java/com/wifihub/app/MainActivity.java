package com.wifihub.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.LinkProperties;
import android.net.LinkAddress;
import android.net.DhcpInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import org.json.JSONObject;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * WiFi Hub — التطبيق الأصلي.
 * يتصل مباشرة براوتر OpenWrt عبر ubus (HTTP) بدون root وبدون أي سيرفر.
 * الجسر (Bridge) يتجاوز قيود CORS لأن موكّد ubus في OpenWrt لا يفعّلها افتراضياً.
 */
public class MainActivity extends Activity {

    private static final String APP_HOST = "app.wifihub.local";
    private static final String APP_BASE = "https://" + APP_HOST + "/";
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " WiFiHubApp/1.0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && APP_HOST.equals(u.getHost())) {
                    String path = u.getPath();
                    if (path == null || path.equals("/")) path = "/index.html";
                    if (path.contains("..")) path = "/index.html";
                    try {
                        InputStream in = getAssets().open("web" + path);
                        String mime = mimeOf(path);
                        WebResourceResponse r = new WebResourceResponse(mime, "utf-8", in);
                        Map<String, String> h = new HashMap<>();
                        h.put("Cache-Control", "no-store");
                        r.setResponseHeaders(h);
                        return r;
                    } catch (IOException e) {
                        return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream("not found".getBytes()));
                    }
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && !APP_HOST.equals(u.getHost())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }
        });

        web.addJavascriptInterface(new Bridge(), "WiFiHub");
        web.loadUrl(APP_BASE + "index.html");
    }

    private static String mimeOf(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        return "text/plain";
    }

    /* ================== الجسر بين التطبيق و JS ================== */
    private class Bridge {

        /** طلب HTTP بدون قيود CORS. يُرجع JSON: {status, body, error} */
        @JavascriptInterface
        public String http(String url, String method, String body, String headersJson) {
            HttpURLConnection c = null;
            try {
                URL u = new URL(url);
                c = (HttpURLConnection) u.openConnection();
                c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
                c.setConnectTimeout(8000);
                c.setReadTimeout(12000);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent", "WiFiHubApp/1.0");
                c.setRequestProperty("Accept", "application/json");
                if (headersJson != null && !headersJson.isEmpty()) {
                    try {
                        org.json.JSONObject o = new org.json.JSONObject(headersJson);
                        java.util.Iterator<String> it = o.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            c.setRequestProperty(k, o.getString(k));
                        }
                    } catch (Exception ignored) { }
                }
                if (body != null && !body.isEmpty() && !"GET".equalsIgnoreCase(method)) {
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(body.getBytes(StandardCharsets.UTF_8).length);
                    OutputStream os = c.getOutputStream();
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                    os.close();
                }
                int code = c.getResponseCode();
                InputStream is = (code >= 200 && code < 400) ? c.getInputStream() : c.getErrorStream();
                String txt = "";
                if (is != null) {
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    txt = bos.toString("UTF-8");
                    is.close();
                }
                JSONObject out = new JSONObject();
                out.put("status", code);
                out.put("body", txt);
                out.put("error", JSONObject.NULL);
                return out.toString();
            } catch (Exception e) {
                try {
                    JSONObject out = new JSONObject();
                    out.put("status", 0);
                    out.put("body", "");
                    out.put("error", String.valueOf(e.getMessage()));
                    return out.toString();
                } catch (Exception ignore) {
                    return "{\"status\":0,\"body\":\"\",\"error\":\"error\"}";
                }
            } finally {
                if (c != null) c.disconnect();
            }
        }

        /** عنوان البوابة الافتراضية = غالباً عنوان الراوتر */
        @JavascriptInterface
        public String gateway() {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network net = cm.getActiveNetwork();
                    if (net != null) {
                        LinkProperties lp = cm.getLinkProperties(net);
                        if (lp != null) {
                            // البوابة من جدول المسارات (الأدق)
                            for (android.net.RouteInfo r : lp.getRoutes()) {
                                java.net.InetAddress gw = r.getGateway();
                                if (gw != null) {
                                    String b = ipToString(gw.getAddress());
                                    if (b != null && !b.equals("0.0.0.0")) return b;
                                }
                            }
                            // البوابة النموذجية (عنوان الجهاز نفسه)
                            for (LinkAddress la : lp.getLinkAddresses()) {
                                if (la.getAddress() != null) {
                                    String b = ipToString(la.getAddress().getAddress());
                                    if (b != null && b.endsWith(".1")) return b;
                                }
                            }
                        }
                    }
                }
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                if (wm != null) {
                    DhcpInfo dh = wm.getDhcpInfo();
                    if (dh != null) {
                        byte[] g = new byte[]{
                            (byte) (dh.gateway & 0xFF), (byte) ((dh.gateway >> 8) & 0xFF),
                            (byte) ((dh.gateway >> 16) & 0xFF), (byte) ((dh.gateway >> 24) & 0xFF)};
                        String b = ipToString(g);
                        if (b != null && !b.equals("0.0.0.0")) return b;
                    }
                }
            } catch (Exception ignored) { }
            return "";
        }

        private String ipToString(byte[] a) {
            if (a == null || a.length < 4) return null;
            return (a[0] & 0xFF) + "." + (a[1] & 0xFF) + "." + (a[2] & 0xFF) + "." + (a[3] & 0xFF);
        }

        /** فتح رابط خارجي (واتساب …) */
        @JavascriptInterface
        public void openExternal(String url) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "تعذّر فتح الرابط", Toast.LENGTH_SHORT).show();
            }
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String appVersion() { return "1.0.0"; }
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); }
        super.onDestroy();
    }
}
