package com.dieyun.agent.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Camera;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

public class MainActivity extends Activity {
    private static final String PREFS = "dieyun_mobile";
    private static final String KEY_URL = "connection_url";
    private static final int REQ_NOTIFY = 2002;
    private static final int REQ_CAMERA = 2003;
    private static final int REQ_AUDIO = 2004;
    private static final String CHANNEL_ID = "dieyun_tasks";

    private FrameLayout root;
    private WebView webView;
    private EditText urlInput;
    private String currentUrl = "";
    private SharedPreferences prefs;
    private boolean updatePromptShown = false;
    private boolean scannerActive = false;
    private boolean webPageLoaded = false;
    private int webLoadId = 0;
    private TextView webLoadingView;
    private PermissionRequest pendingAudioPermissionRequest;
    private TextView connectStatus;
    private boolean decodingFrame = false;
    private Camera camera;
    private TextView scannerStatus;
    private final MultiFormatReader qrReader = new MultiFormatReader();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Arrays.asList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        qrReader.setHints(hints);
        createNotificationChannel();
        requestNotificationPermissionIfNeeded();
        showConnectScreen(prefs.getString(KEY_URL, ""));
        checkForUpdates(false);
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private TextView text(String content, float size, int color) {
        TextView v = new TextView(this);
        v.setText(content);
        v.setTextSize(size);
        v.setTextColor(color);
        v.setLineSpacing(dp(2), 1.0f);
        return v;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(primary ? Color.BLACK : Color.WHITE);
        b.setBackgroundColor(primary ? Color.WHITE : Color.rgb(35, 35, 35));
        return b;
    }

    private void showConnectScreen(String initialUrl) {
        scannerActive = false;
        webPageLoaded = false;
        webLoadingView = null;
        connectStatus = null;
        destroyWebView();
        stopCamera();
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(15, 15, 15));

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(22), dp(30), dp(22), dp(22));
        panel.setGravity(Gravity.CENTER_HORIZONTAL);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.dieyun_logo);
        logo.setAdjustViewBounds(true);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(dp(72), dp(72));
        logoLp.setMargins(0, 0, 0, dp(12));
        panel.addView(logo, logoLp);

        TextView title = text("叠云AI", 26, Color.WHITE);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(null, 1);
        panel.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView version = text("手机版 v" + currentVersionName(), 12, Color.rgb(150, 150, 150));
        version.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams versionLp = new LinearLayout.LayoutParams(-1, -2);
        versionLp.setMargins(0, dp(4), 0, 0);
        panel.addView(version, versionLp);

        TextView desc = text("手机端仅作为内网频道，任务仍由电脑执行。扫描 PC 端「手机连接」二维码，或粘贴连接地址。", 14, Color.rgb(175, 175, 175));
        desc.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams descLp = new LinearLayout.LayoutParams(-1, -2);
        descLp.setMargins(0, dp(10), 0, dp(24));
        panel.addView(desc, descLp);

        urlInput = new EditText(this);
        urlInput.setSingleLine(false);
        urlInput.setMinLines(3);
        urlInput.setHint("http://电脑IP:17331/#token=...");
        urlInput.setHintTextColor(Color.rgb(120, 120, 120));
        urlInput.setTextColor(Color.WHITE);
        urlInput.setText(initialUrl == null ? "" : initialUrl);
        urlInput.setTextSize(14);
        urlInput.setBackgroundColor(Color.rgb(24, 24, 24));
        urlInput.setPadding(dp(12), dp(10), dp(12), dp(10));
        panel.addView(urlInput, new LinearLayout.LayoutParams(-1, dp(96)));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(-1, -2);
        actionsLp.setMargins(0, dp(12), 0, 0);

        Button scan = button("扫码", false);
        Button paste = button("粘贴", false);
        Button connect = button("连接", true);
        actions.addView(scan, new LinearLayout.LayoutParams(0, dp(48), 1));
        addGap(actions, 8);
        actions.addView(paste, new LinearLayout.LayoutParams(0, dp(48), 1));
        addGap(actions, 8);
        actions.addView(connect, new LinearLayout.LayoutParams(0, dp(48), 1));
        panel.addView(actions, actionsLp);

        connectStatus = text("", 12, Color.rgb(230, 140, 140));
        connectStatus.setVisibility(View.GONE);
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(-1, -2);
        statusLp.setMargins(0, dp(12), 0, 0);
        panel.addView(connectStatus, statusLp);

        TextView hint = text("提示：扫码会打开手机摄像头；如果系统 WebView 不支持二维码识别，可在 PC 端复制连接地址后粘贴。", 12, Color.rgb(130, 130, 130));
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(-1, -2);
        hintLp.setMargins(0, dp(18), 0, 0);
        panel.addView(hint, hintLp);

        FrameLayout.LayoutParams panelLp = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
        root.addView(panel, panelLp);
        setContentView(root);

        scan.setOnClickListener(v -> startBuiltInScanner());
        paste.setOnClickListener(v -> pasteFromClipboard());
        connect.setOnClickListener(v -> connectToUrl(urlInput.getText().toString()));
    }

    private void addGap(LinearLayout parent, int widthDp) {
        View gap = new View(this);
        parent.addView(gap, new LinearLayout.LayoutParams(dp(widthDp), 1));
    }

    private void pasteFromClipboard() {
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) {
            toast("剪贴板为空");
            return;
        }
        ClipData data = cm.getPrimaryClip();
        if (data == null || data.getItemCount() == 0) {
            toast("剪贴板为空");
            return;
        }
        CharSequence text = data.getItemAt(0).coerceToText(this);
        if (text == null) {
            toast("剪贴板没有文本");
            return;
        }
        urlInput.setText(text.toString().trim());
    }

    private void startBuiltInScanner() {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
            return;
        }
        showScannerScreen();
    }

    private void showScannerScreen() {
        scannerActive = true;
        decodingFrame = false;
        stopCamera();
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setPadding(dp(12), dp(16), dp(12), dp(12));
        shell.setBackgroundColor(Color.BLACK);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text("扫码连接电脑", 16, Color.WHITE);
        title.setTypeface(null, 1);
        Button cancel = button("取消", false);
        head.addView(title, new LinearLayout.LayoutParams(0, dp(44), 1));
        head.addView(cancel, new LinearLayout.LayoutParams(dp(78), dp(40)));
        shell.addView(head, new LinearLayout.LayoutParams(-1, -2));

        scannerStatus = text("正在打开摄像头…", 13, Color.rgb(190, 190, 190));
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(-1, -2);
        statusLp.setMargins(0, 0, 0, dp(10));
        shell.addView(scannerStatus, statusLp);

        FrameLayout stage = new FrameLayout(this);
        stage.setBackgroundColor(Color.rgb(10, 10, 10));
        SurfaceView preview = new SurfaceView(this);
        stage.addView(preview, new FrameLayout.LayoutParams(-1, -1));
        TextView frame = text("将二维码放入画面中央", 13, Color.WHITE);
        frame.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams frameLp = new FrameLayout.LayoutParams(dp(230), dp(230), Gravity.CENTER);
        stage.addView(frame, frameLp);
        shell.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1));

        TextView foot = text("请对准 PC 端「手机连接」二维码，识别后自动连接。", 12, Color.rgb(150, 150, 150));
        foot.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams footLp = new LinearLayout.LayoutParams(-1, -2);
        footLp.setMargins(0, dp(10), 0, 0);
        shell.addView(foot, footLp);

        root.addView(shell, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        cancel.setOnClickListener(v -> cancelScanner());
        preview.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override
            public void surfaceCreated(SurfaceHolder holder) {
                openCamera(holder);
            }

            @Override
            public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
                // Camera preview is already bound on creation.
            }

            @Override
            public void surfaceDestroyed(SurfaceHolder holder) {
                stopCamera();
            }
        });
    }

    private void connectToUrl(String raw) {
        String url = normalizeUrl(raw);
        if (url == null) {
            toast("请输入有效的 http/https 连接地址");
            return;
        }
        probeAndOpen(url);
    }

    private String normalizeUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        if (!value.toLowerCase(Locale.ROOT).startsWith("http://") && !value.toLowerCase(Locale.ROOT).startsWith("https://")) {
            value = "http://" + value;
        }
        try {
            Uri uri = Uri.parse(value);
            if (uri.getHost() == null) return null;
            return value;
        } catch (Exception e) {
            return null;
        }
    }

    private void probeAndOpen(String url) {
        toast("正在检测电脑端服务…");
        new Thread(() -> {
            String error = probeMobileService(url);
            runOnUiThread(() -> {
                if (error == null) {
                    prefs.edit().putString(KEY_URL, url).apply();
                    showWebView(url);
                    return;
                }
                if (urlInput != null) urlInput.setText(url);
                showConnectionError(error);
            });
        }).start();
    }

    private void showConnectionError(String error) {
        String message = "连接失败：" + (error == null || error.trim().isEmpty() ? "未知错误" : error);
        if (connectStatus != null) {
            connectStatus.setText(message);
            connectStatus.setVisibility(View.VISIBLE);
        }
        new AlertDialog.Builder(this)
                .setTitle("连接失败")
                .setMessage(message)
                .setPositiveButton("知道了", null)
                .show();
    }

    private String probeMobileService(String url) {
        HttpURLConnection conn = null;
        try {
            Uri original = Uri.parse(url);
            Uri probeUri = original.buildUpon()
                    .path("/api/info")
                    .query(null)
                    .fragment(null)
                    .build();
            conn = (HttpURLConnection) new URL(probeUri.toString()).openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return "HTTP " + code;
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            JSONObject json = new JSONObject(body.toString());
            if (!json.optBoolean("ok", false)) return "服务响应异常";
            return null;
        } catch (Exception e) {
            String message = e.getMessage();
            if (message == null || message.trim().isEmpty()) message = e.getClass().getSimpleName();
            return message;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void setScannerStatus(String text) {
        if (scannerStatus != null) scannerStatus.setText(text);
    }

    private void openCamera(SurfaceHolder holder) {
        try {
            stopCamera();
            camera = Camera.open();
            Camera.Parameters params = camera.getParameters();
            if (params.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            } else if (params.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                params.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
            }
            Camera.Size best = choosePreviewSize(params);
            if (best != null) params.setPreviewSize(best.width, best.height);
            camera.setParameters(params);
            camera.setDisplayOrientation(90);
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback((data, cam) -> decodePreviewFrame(data, cam));
            camera.startPreview();
            setScannerStatus("正在识别…请保持二维码清晰居中");
        } catch (Exception e) {
            setScannerStatus("摄像头打开失败：" + e.getMessage());
            toast("摄像头打开失败");
            stopCamera();
        }
    }

    private Camera.Size choosePreviewSize(Camera.Parameters params) {
        Camera.Size fallback = params.getPreviewSize();
        Camera.Size best = null;
        for (Camera.Size size : params.getSupportedPreviewSizes()) {
            int pixels = size.width * size.height;
            if (pixels < 300000 || pixels > 1500000) continue;
            if (best == null || Math.abs(size.width - 1280) < Math.abs(best.width - 1280)) {
                best = size;
            }
        }
        return best != null ? best : fallback;
    }

    private void decodePreviewFrame(byte[] data, Camera cam) {
        if (!scannerActive || decodingFrame || data == null || cam == null) return;
        Camera.Size size;
        try {
            size = cam.getParameters().getPreviewSize();
        } catch (Exception e) {
            return;
        }
        if (size == null || size.width <= 0 || size.height <= 0) return;
        int ySize = size.width * size.height;
        if (data.length < ySize) return;
        decodingFrame = true;
        byte[] luminance = Arrays.copyOf(data, ySize);
        new Thread(() -> {
            String decoded = null;
            try {
                decoded = decodeQr(luminance, size.width, size.height);
            } finally {
                decodingFrame = false;
            }
            if (decoded != null && !decoded.trim().isEmpty()) {
                final String result = decoded.trim();
                runOnUiThread(() -> {
                    if (!scannerActive) return;
                    scannerActive = false;
                    stopCamera();
                    connectToUrl(result);
                });
            }
        }).start();
    }

    private String decodeQr(byte[] yPlane, int width, int height) {
        String direct = decodeQrFromPlane(yPlane, width, height);
        if (direct != null) return direct;
        byte[] rotated90 = rotateYPlane90(yPlane, width, height);
        String by90 = decodeQrFromPlane(rotated90, height, width);
        if (by90 != null) return by90;
        byte[] rotated270 = rotateYPlane270(yPlane, width, height);
        return decodeQrFromPlane(rotated270, height, width);
    }

    private String decodeQrFromPlane(byte[] yPlane, int width, int height) {
        try {
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                    yPlane,
                    width,
                    height,
                    0,
                    0,
                    width,
                    height,
                    false
            );
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = qrReader.decodeWithState(bitmap);
            qrReader.reset();
            return result == null ? null : result.getText();
        } catch (NotFoundException e) {
            qrReader.reset();
            return null;
        } catch (Exception e) {
            qrReader.reset();
            return null;
        }
    }

    private byte[] rotateYPlane90(byte[] data, int width, int height) {
        byte[] rotated = new byte[width * height];
        int i = 0;
        for (int x = 0; x < width; x++) {
            for (int y = height - 1; y >= 0; y--) {
                rotated[i++] = data[y * width + x];
            }
        }
        return rotated;
    }

    private byte[] rotateYPlane270(byte[] data, int width, int height) {
        byte[] rotated = new byte[width * height];
        int i = 0;
        for (int x = width - 1; x >= 0; x--) {
            for (int y = 0; y < height; y++) {
                rotated[i++] = data[y * width + x];
            }
        }
        return rotated;
    }

    private void stopCamera() {
        if (camera == null) return;
        try {
            camera.setPreviewCallback(null);
            camera.stopPreview();
        } catch (Exception e) {
            // ignore
        }
        try {
            camera.release();
        } catch (Exception e) {
            // ignore
        }
        camera = null;
    }

    private void cancelScanner() {
        scannerActive = false;
        stopCamera();
        showConnectScreen(prefs.getString(KEY_URL, ""));
    }

    private void showWebView(String url) {
        scannerActive = false;
        stopCamera();
        destroyWebView();
        currentUrl = url;
        webPageLoaded = false;
        final int loadId = ++webLoadId;
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(15, 15, 15));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(15, 15, 15));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        configureWebView(webView);

        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        webLoadingView = text("正在连接电脑端…", 14, Color.rgb(210, 210, 210));
        webLoadingView.setGravity(Gravity.CENTER);
        webLoadingView.setBackgroundColor(Color.rgb(15, 15, 15));
        root.addView(webLoadingView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        webView.loadUrl(url);
        root.postDelayed(() -> {
            if (loadId == webLoadId && !webPageLoaded && webView != null && root != null) {
                markWebPageReady();
                toast("服务已连通，页面脚本仍在连接中");
            }
        }, 12000);
    }

    private void configureWebView(WebView view) {
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        view.addJavascriptInterface(new NativeBridge(), "DieyunApp");
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (request == null) return;
                runOnUiThread(() -> {
                    String[] resources = request.getResources();
                    boolean needsAudio = false;
                    if (resources != null) {
                        for (String resource : resources) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                                needsAudio = true;
                                break;
                            }
                        }
                    }
                    if (!needsAudio) {
                        request.grant(resources);
                        return;
                    }
                    if (Build.VERSION.SDK_INT >= 23
                            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        pendingAudioPermissionRequest = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
                        return;
                    }
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                });
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                webPageLoaded = false;
                if (webLoadingView != null) {
                    webLoadingView.setText("正在连接电脑端…");
                    webLoadingView.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                markWebPageReady();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                view.postDelayed(() -> {
                    if (view == null) return;
                    view.evaluateJavascript(
                            "(function(){return ((document.body&&document.body.innerText)||'').trim().length;})()",
                            value -> {
                                int length = 0;
                                try {
                                    String raw = value == null ? "0" : String.valueOf(value);
                                    length = Integer.parseInt(raw.replace("\"", ""));
                                } catch (Exception e) {
                                    length = 0;
                                }
                                if (length > 0 || url != null) markWebPageReady();
                            }
                    );
                }, 800);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    promptWebLoadFailure("页面加载失败，请确认电脑和手机在同一内网");
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (request != null && request.isForMainFrame()) {
                    int code = errorResponse == null ? 0 : errorResponse.getStatusCode();
                    promptWebLoadFailure("连接失败：HTTP " + code);
                }
            }
        });
    }

    private void destroyWebView() {
        if (webView == null) return;
        try {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        } catch (Exception e) {
            // ignore
        }
        webView = null;
        webLoadingView = null;
        webPageLoaded = false;
    }

    private void promptWebLoadFailure(String message) {
        toast(message);
        new AlertDialog.Builder(this)
                .setTitle("连接失败")
                .setMessage(message + "\n\n是否返回重新连接？")
                .setPositiveButton("重新连接", (dialog, which) -> showConnectScreen(prefs.getString(KEY_URL, "")))
                .setNegativeButton("留在页面", null)
                .show();
    }

    private void markWebPageReady() {
        webPageLoaded = true;
        if (webLoadingView != null) webLoadingView.setVisibility(View.GONE);
    }

    @Override
    public void onBackPressed() {
        if (scannerActive) {
            cancelScanner();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopCamera();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                showScannerScreen();
            } else {
                toast("未授权摄像头，无法扫码");
            }
            return;
        }
        if (requestCode == REQ_AUDIO) {
            PermissionRequest pending = pendingAudioPermissionRequest;
            pendingAudioPermissionRequest = null;
            if (pending == null) return;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pending.deny();
                toast("未授权麦克风，无法语音输入");
            }
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "叠云任务通知",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    private void showNativeNotification(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            toast("通知未授权，可在系统设置中开启");
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            try {
                startActivity(intent);
            } catch (Exception e) {
                // ignore — user can open settings manually
            }
            return;
        }
        android.app.Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new android.app.Notification.Builder(this, CHANNEL_ID)
                : new android.app.Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title == null || title.isEmpty() ? "叠云AI" : title)
                .setContentText(body == null ? "" : body)
                .setAutoCancel(true);
        nm.notify((int) (System.currentTimeMillis() & 0xfffffff), builder.build());
    }

    private String currentVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "0.0.0" : info.versionName;
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    private long currentVersionCode() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return info.getLongVersionCode();
            }
            return info.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String resolveUpdateDownloadUrl(String rawUrl, String manifestUrl) {
        String value = rawUrl == null ? "" : rawUrl.trim();
        if (value.isEmpty()) return "";
        String lower = value.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://")) return value;
        String baseUrl = manifestUrl == null || manifestUrl.trim().isEmpty()
                ? getString(R.string.mobile_update_manifest_url)
                : manifestUrl.trim();
        int slash = baseUrl.lastIndexOf('/');
        String base = slash >= 0 ? baseUrl.substring(0, slash + 1) : baseUrl;
        return base + value.replaceFirst("^/+", "");
    }

    private List<String> getUpdateManifestUrls() {
        List<String> urls = new ArrayList<>();
        addUniqueManifestUrl(urls, getString(R.string.mobile_update_manifest_url));
        try {
            addUniqueManifestUrl(urls, getString(R.string.mobile_update_manifest_url_fallback));
        } catch (Exception ignored) {
        }
        return urls;
    }

    private void addUniqueManifestUrl(List<String> urls, String url) {
        if (url == null) return;
        String trimmed = url.trim();
        if (trimmed.isEmpty()) return;
        for (String existing : urls) {
            if (existing.equals(trimmed)) return;
        }
        urls.add(trimmed);
    }

    private JSONObject fetchUpdateManifest(String manifestUrl) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(manifestUrl).openConnection();
        conn.setConnectTimeout(6000);
        conn.setReadTimeout(8000);
        conn.setRequestProperty("Accept", "application/json");
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
        }
        return new JSONObject(body.toString());
    }

    private void checkForUpdates(boolean manual) {
        new Thread(() -> {
            Exception lastError = null;
            for (String manifestUrl : getUpdateManifestUrls()) {
                try {
                    JSONObject json = fetchUpdateManifest(manifestUrl);
                    long latestCode = json.optLong("versionCode", 0);
                    String latestName = json.optString("versionName", "");
                    String apkUrl = resolveUpdateDownloadUrl(json.optString("url", json.optString("apk", "")), manifestUrl);
                    boolean hasUpdate = latestCode > currentVersionCode() && !apkUrl.isEmpty();
                    runOnUiThread(() -> {
                        if (hasUpdate) {
                            showUpdateDialog(latestName, latestCode, apkUrl, manual);
                        } else if (manual) {
                            toast("当前已是最新版");
                        }
                    });
                    return;
                } catch (Exception e) {
                    lastError = e;
                }
            }
            if (manual && lastError != null) {
                Exception err = lastError;
                runOnUiThread(() -> toast("检查更新失败：" + err.getMessage()));
            }
        }).start();
    }

    private void showUpdateDialog(String versionName, long versionCode, String apkUrl, boolean manual) {
        if (!manual && updatePromptShown) return;
        updatePromptShown = true;
        String name = versionName == null || versionName.isEmpty() ? String.valueOf(versionCode) : versionName;
        new AlertDialog.Builder(this)
                .setTitle("发现手机版新版本")
                .setMessage("当前 v" + currentVersionName() + "，最新 v" + name + "。是否下载 APK？")
                .setPositiveButton("下载", (dialog, which) -> openExternalUrl(apkUrl))
                .setNegativeButton("稍后", null)
                .show();
    }

    private void openExternalUrl(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            startActivity(intent);
        } catch (Exception e) {
            toast("无法打开下载地址");
        }
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    public class NativeBridge {
        @JavascriptInterface
        public void notify(String title, String body) {
            runOnUiThread(() -> showNativeNotification(title, body));
        }

        @JavascriptInterface
        public void reconnect() {
            runOnUiThread(() -> {
                if (webView != null) webView.reload();
                else if (currentUrl != null && !currentUrl.isEmpty()) showWebView(currentUrl);
            });
        }

        @JavascriptInterface
        public void changeComputer() {
            runOnUiThread(() -> showConnectScreen(prefs.getString(KEY_URL, "")));
        }

        @JavascriptInterface
        public void checkForUpdates() {
            runOnUiThread(() -> {
                toast("正在检查更新…");
                MainActivity.this.checkForUpdates(true);
            });
        }

        @JavascriptInterface
        public void pageReady() {
            runOnUiThread(() -> markWebPageReady());
        }
    }
}
