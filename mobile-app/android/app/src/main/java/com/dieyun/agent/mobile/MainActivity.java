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
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.hardware.Camera;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Base64;
import android.view.Gravity;
import android.view.Surface;
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
import java.io.ByteArrayOutputStream;
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
    /** Agent 主动拍照的一次性权限申请（与扫码用的 REQ_CAMERA 分开：两条流程后续动作不同）。 */
    private static final int REQ_CAMERA_CAPTURE = 2005;
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
    /** Agent 主动拍照专用的相机会话（与扫码的 `camera` 分开：两者的预览/生命周期不同）。 */
    private Camera captureCamera;
    private boolean captureInFlight = false;
    /** 预览是否真的起来了（决定 6s 兜底是「再等等」还是「判定失败」）。 */
    private boolean capturePreviewStarted = false;
    private String captureRequestId = "";
    private String captureFacing = "environment";
    private int captureMaxEdge = 1280;
    private SurfaceView captureSurfaceView;
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
        // 页面要没了：正在飞的那次拍照必须收尾（释放相机 + 让电脑端看到明确失败）
        if (captureInFlight) {
            releaseCaptureCamera();
            captureInFlight = false;
            deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_BUSY");
        }
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
        // 页面切后台时正在拍的这一张没意义了：立刻释放相机，并让电脑端收到明确的失败。
        // 注意只在**相机已经打开**时才收尾：权限对话框弹出同样会触发 onPause，
        // 那种情况下这次拍摄还没开始，收尾会把「刚申请的权限」变成一次假失败。
        if (captureInFlight && captureCamera != null) {
            releaseCaptureCamera();
            captureInFlight = false;
            deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_BUSY");
        }
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
        if (requestCode == REQ_CAMERA_CAPTURE) {
            // 授权期间这次拍摄可能已被取消（切后台 / 换页面）：没人在等就别再开相机
            if (!captureInFlight) return;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                toast("叠云正在拍一张…");
                openCaptureCamera();
            } else {
                captureInFlight = false;
                deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_DENIED");
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

    // ---------- Agent 主动拍照（camera_look 的手机端） ----------
    //
    // 为什么走原生而不是页面的 getUserMedia：手机端页面通常是 http://局域网IP，
    // 属非安全上下文，Chromium（WebView 也一样）在这些源上根本不提供 navigator.mediaDevices。
    // 原生相机没这个限制，还能自己定分辨率和压缩质量，回传体积因此可控。
    //
    // 为什么是「一次一张」：不做常开预览、不做视频流 —— 每次拍摄都 toast 提示（不隐蔽采集），
    // 拍完立刻释放相机，不长期占用硬件（也就不会挡住扫码或别的 App）。

    /** 页面（app.js）请求拍一张。跑在 JS 线程，所有相机动作都转回主线程。 */
    private void startAgentCapture(String requestId, String facing, int maxEdge) {
        if (webView == null) {
            deliverCameraResult(requestId, false, null, 0, 0, "CAMERA_UNAVAILABLE");
            return;
        }
        if (captureInFlight || scannerActive) {
            // 扫码相机占着硬件 / 已经有一次拍摄在飞：不抢，让电脑端知道换个时机
            deliverCameraResult(requestId, false, null, 0, 0, "CAMERA_BUSY");
            return;
        }
        captureRequestId = requestId == null ? "" : requestId;
        captureFacing = "user".equals(facing) ? "user" : "environment";
        captureMaxEdge = maxEdge <= 0 ? 1280 : Math.max(320, Math.min(2048, maxEdge));
        captureInFlight = true;
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            // 首次使用：先要权限，结果回来后再继续这同一次拍摄（不丢请求）
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_CAPTURE);
            return;
        }
        // 可见提示只有页面那一处（app.js 的 toast）：这里再弹一次就是两条重复提示。
        // 唯一例外是刚拿到权限的情况（见 onRequestPermissionsResult），那时页面提示
        // 可能已被权限弹窗盖掉，需要补一句让用户知道「现在真的在拍」。
        openCaptureCamera();
    }

    private void openCaptureCamera() {
        // 权限对话框弹出/页面切走可能已经把这次拍摄取消了：没人在等就别再开相机
        if (!captureInFlight) return;
        try {
            releaseCaptureCamera();
            captureCamera = Camera.open(findCaptureCameraId(captureFacing));
            Camera.Parameters params = captureCamera.getParameters();
            List<String> focusModes = params.getSupportedFocusModes();
            if (focusModes != null && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            Camera.Size preview = choosePreviewSize(params);
            if (preview != null) params.setPreviewSize(preview.width, preview.height);
            Camera.Size picture = choosePictureSize(params, captureMaxEdge);
            if (picture != null) params.setPictureSize(picture.width, picture.height);
            params.setJpegQuality(85);
            try {
                captureCamera.setParameters(params);
            } catch (Exception ignored) {
                // 部分机型不支持「这个预览尺寸 + 这个照片尺寸」的组合：退回相机默认参数。
                // 宁可分辨率低一点，也不要整次拍摄直接失败。
            }
        } catch (Exception e) {
            releaseCaptureCamera();
            captureInFlight = false;
            deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_OPEN_FAILED");
            return;
        }
        // takePicture 要求预览在跑：用 1dp 的离屏 SurfaceView 当预览目标。
        // 它被 WebView 完全盖住（用户看不见），但 Surface 是真实存在的 ——
        // 这是「不弹系统相机 UI、静默拍一张」的标准做法。
        SurfaceView surface = ensureCaptureSurface();
        SurfaceHolder holder = surface == null ? null : surface.getHolder();
        if (holder == null) {
            releaseCaptureCamera();
            captureInFlight = false;
            deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_OPEN_FAILED");
            return;
        }
        // Surface 可能还没创建（视图刚加上去）：等 surfaceCreated 再 startPreview，
        // 否则 setPreviewDisplay 会抛 IllegalArgumentException / IOException。
        if (holder.getSurface() != null && holder.getSurface().isValid()) {
            beginCapturePreview(holder);
        } else {
            holder.addCallback(new SurfaceHolder.Callback() {
                @Override
                public void surfaceCreated(SurfaceHolder h) {
                    beginCapturePreview(h);
                }

                @Override
                public void surfaceChanged(SurfaceHolder h, int format, int width, int height) {
                    // 预览尺寸在 openCaptureCamera 里已设定，这里不需要重配。
                }

                @Override
                public void surfaceDestroyed(SurfaceHolder h) {
                    // 释放由 releaseCaptureCamera 统一负责。
                }
            });
            // 兜底：Surface 迟迟不创建就别让电脑端干等到超时（相机开着不释放更糟）
            View anchor = root != null ? root : webView;
            if (anchor != null) {
                anchor.postDelayed(() -> {
                    if (!captureInFlight || captureCamera == null) return;
                    if (capturePreviewStarted) return;
                    releaseCaptureCamera();
                    captureInFlight = false;
                    deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_OPEN_FAILED");
                }, 6000);
            }
        }
    }

    private void beginCapturePreview(SurfaceHolder holder) {
        Camera cam = captureCamera;
        if (cam == null) return;
        try {
            cam.setPreviewDisplay(holder);
            cam.startPreview();
            capturePreviewStarted = true;
        } catch (Exception e) {
            releaseCaptureCamera();
            captureInFlight = false;
            deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_OPEN_FAILED");
            return;
        }
        // 给自动对焦/曝光一点时间再按快门：立刻拍到的常是模糊或过暗的一帧，白交给模型。
        View anchor = root != null ? root : webView;
        if (anchor != null) anchor.postDelayed(this::takeCaptureShot, 700);
        else takeCaptureShot();
    }

    private void takeCaptureShot() {
        Camera cam = captureCamera;
        if (cam == null) return;
        try {
            cam.takePicture(null, null, (data, source) -> onCaptureJpeg(data));
        } catch (Exception e) {
            releaseCaptureCamera();
            captureInFlight = false;
            deliverCameraResult(captureRequestId, false, null, 0, 0, "CAMERA_CAPTURE_FAILED");
        }
    }

    /** JPEG 解码/缩放/旋转/压缩都在后台线程做，避免卡住 WebView。 */
    private void onCaptureJpeg(final byte[] data) {
        final String requestId = captureRequestId;
        final String facing = captureFacing;
        final int maxEdge = captureMaxEdge;
        new Thread(() -> {
            String base64 = null;
            int width = 0;
            int height = 0;
            String error = "CAMERA_ENCODE_FAILED";
            try {
                if (data != null && data.length > 0) {
                    Bitmap bitmap = decodeScaledJpeg(data, maxEdge);
                    if (bitmap != null) {
                        int orientation = captureRotationDegrees(facing);
                        if (orientation != 0) {
                            Matrix matrix = new Matrix();
                            matrix.postRotate(orientation);
                            Bitmap rotated = Bitmap.createBitmap(
                                    bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                            if (rotated != bitmap) bitmap.recycle();
                            bitmap = rotated;
                        }
                        width = bitmap.getWidth();
                        height = bitmap.getHeight();
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 72, out);
                        bitmap.recycle();
                        base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                        error = null;
                    }
                }
            } catch (Exception e) {
                base64 = null;
                error = "CAMERA_ENCODE_FAILED";
            } catch (OutOfMemoryError e) {
                base64 = null;
                error = "CAMERA_ENCODE_FAILED";
            }
            final String encoded = base64;
            final int w = width;
            final int h = height;
            final String err = error;
            runOnUiThread(() -> {
                releaseCaptureCamera();
                captureInFlight = false;
                deliverCameraResult(requestId, err == null, encoded, w, h, err);
            });
        }).start();
    }

    private Bitmap decodeScaledJpeg(byte[] data, int maxEdge) {
        BitmapFactory.Options probe = new BitmapFactory.Options();
        probe.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, probe);
        int longEdge = Math.max(probe.outWidth, probe.outHeight);
        int sample = 1;
        while (longEdge / (sample * 2) >= maxEdge * 2 && sample < 8) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
        if (bitmap == null) return null;
        int current = Math.max(bitmap.getWidth(), bitmap.getHeight());
        if (current <= maxEdge) return bitmap;
        float scale = (float) maxEdge / (float) current;
        Bitmap scaled = Bitmap.createScaledBitmap(
                bitmap,
                Math.max(1, Math.round(bitmap.getWidth() * scale)),
                Math.max(1, Math.round(bitmap.getHeight() * scale)),
                true);
        if (scaled != bitmap) bitmap.recycle();
        return scaled;
    }

    /** 选「不小于目标长边的最小档」，让相机少出无用的像素（回传更快，也更省内存）。 */
    private Camera.Size choosePictureSize(Camera.Parameters params, int maxEdge) {
        Camera.Size fallback = params.getPictureSize();
        List<Camera.Size> sizes = params.getSupportedPictureSizes();
        if (sizes == null || sizes.isEmpty()) return fallback;
        Camera.Size best = null;
        for (Camera.Size size : sizes) {
            int longEdge = Math.max(size.width, size.height);
            if (longEdge < maxEdge) continue;
            if (best == null || longEdge < Math.max(best.width, best.height)) best = size;
        }
        if (best != null) return best;
        for (Camera.Size size : sizes) {
            if (best == null || Math.max(size.width, size.height) > Math.max(best.width, best.height)) {
                best = size;
            }
        }
        return best != null ? best : fallback;
    }

    private int findCaptureCameraId(String facing) {
        int wanted = "user".equals(facing)
                ? Camera.CameraInfo.CAMERA_FACING_FRONT
                : Camera.CameraInfo.CAMERA_FACING_BACK;
        int count = Camera.getNumberOfCameras();
        Camera.CameraInfo info = new Camera.CameraInfo();
        for (int i = 0; i < count; i++) {
            Camera.getCameraInfo(i, info);
            if (info.facing == wanted) return i;
        }
        return 0;
    }

    /**
     * JPEG 相对「自然方向」的旋转角。
     *
     * 为什么不能只用 `info.orientation`：那是**传感器**的装配角度，只对「手机竖直握持」成立。
     * 用户横着把手机举到桌面前一拍，只按传感器角度转会得到一张侧倒的图 —— 模型看这样的图
     * 会把桌面读成墙、把横向读成纵向。所以把设备当前旋转一起算进去（前后置公式不同）。
     */
    private int captureRotationDegrees(String facing) {
        try {
            Camera.CameraInfo info = new Camera.CameraInfo();
            Camera.getCameraInfo(findCaptureCameraId(facing), info);
            int degrees;
            switch (getWindowManager().getDefaultDisplay().getRotation()) {
                case Surface.ROTATION_90:
                    degrees = 90;
                    break;
                case Surface.ROTATION_180:
                    degrees = 180;
                    break;
                case Surface.ROTATION_270:
                    degrees = 270;
                    break;
                default:
                    degrees = 0;
                    break;
            }
            if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
                return (info.orientation + degrees) % 360;
            }
            return (info.orientation - degrees + 360) % 360;
        } catch (Exception e) {
            return 0;
        }
    }

    private SurfaceView ensureCaptureSurface() {
        if (captureSurfaceView != null && captureSurfaceView.getParent() != null) return captureSurfaceView;
        SurfaceView surface = new SurfaceView(this);
        captureSurfaceView = surface;
        if (root != null) {
            root.addView(surface, 0, new FrameLayout.LayoutParams(dp(1), dp(1)));
        }
        return surface;
    }

    private void releaseCaptureCamera() {
        capturePreviewStarted = false;
        if (captureCamera != null) {
            try {
                captureCamera.stopPreview();
            } catch (Exception e) {
                // ignore
            }
            try {
                captureCamera.release();
            } catch (Exception e) {
                // ignore
            }
            captureCamera = null;
        }
        if (captureSurfaceView != null && root != null) {
            try {
                root.removeView(captureSurfaceView);
            } catch (Exception e) {
                // ignore
            }
        }
        captureSurfaceView = null;
    }

    /** 把结果交给页面：页面拿着 base64 回给电脑端（协议见 src/mobile/bridge.js）。 */
    private void deliverCameraResult(String requestId, boolean ok, String base64, int width, int height, String errorCode) {
        WebView view = webView;
        if (view == null) return;
        if (!ok && (base64 == null || base64.isEmpty())) {
            toast("拍照失败：" + (errorCode == null ? "UNKNOWN" : errorCode));
        }
        String js = "(function(){var f=window.__dieyunCameraResult;if(typeof f==='function'){f("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(base64 == null ? "" : base64) + ","
                + width + "," + height + ","
                + JSONObject.quote(errorCode == null ? "" : errorCode)
                + ");}})()";
        try {
            view.evaluateJavascript(js, null);
        } catch (Exception e) {
            // 页面已销毁：请求侧会按超时处理
        }
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

        /**
         * Agent 主动拍照：参数由页面按电脑端的 `camera.capture` 请求原样转来。
         * 完成后通过 window.__dieyunCameraResult(...) 回给页面（异步，可能走权限申请）。
         */
        @JavascriptInterface
        public void capturePhoto(String requestId, String facing, int maxEdge) {
            final String rid = requestId == null ? "" : requestId;
            final String face = facing == null ? "environment" : facing;
            final int edge = maxEdge;
            runOnUiThread(() -> startAgentCapture(rid, face, edge));
        }
    }
}
