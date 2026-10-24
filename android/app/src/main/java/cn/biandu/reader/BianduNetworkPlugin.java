package cn.biandu.reader;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "BianduNetwork")
public class BianduNetworkPlugin extends Plugin {
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final Map<String, HttpURLConnection> ACTIVE_REQUESTS = new ConcurrentHashMap<>();
    private static final Set<String> CANCELLED_REQUESTS = ConcurrentHashMap.newKeySet();
    private final ExecutorService executor = Executors.newFixedThreadPool(4);

    @PluginMethod
    public void postJson(PluginCall call) {
        String endpoint = call.getString("url");
        String body = call.getString("body", "");
        String requestId = call.getString("requestId", UUID.randomUUID().toString());
        JSObject headers = call.getObject("headers", new JSObject());
        int timeoutMs = Math.max(5_000, Math.min(240_000, call.getInt("timeoutMs", 90_000)));
        if (endpoint == null || endpoint.isEmpty()) {
            call.reject("模型接口地址为空。");
            return;
        }
        executor.execute(() -> executePost(call, requestId, endpoint, headers, body, timeoutMs));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId != null && !requestId.isEmpty()) {
            CANCELLED_REQUESTS.add(requestId);
            HttpURLConnection connection = ACTIVE_REQUESTS.get(requestId);
            if (connection != null) connection.disconnect();
        }
        call.resolve();
    }

    public static void cancelAll() {
        for (Map.Entry<String, HttpURLConnection> entry : ACTIVE_REQUESTS.entrySet()) {
            CANCELLED_REQUESTS.add(entry.getKey());
            entry.getValue().disconnect();
        }
        ACTIVE_REQUESTS.clear();
    }

    private void executePost(PluginCall call, String requestId, String endpoint, JSObject headers, String body, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(endpoint);
            String scheme = url.getProtocol();
            String host = url.getHost();
            boolean localHttp = "http".equalsIgnoreCase(scheme) &&
                ("localhost".equalsIgnoreCase(host) || "127.0.0.1".equalsIgnoreCase(host));
            if (!"https".equalsIgnoreCase(scheme) && !localHttp) {
                throw new IllegalArgumentException("模型接口必须使用 HTTPS；本机调试仅允许 localhost HTTP。");
            }
            byte[] requestBytes = body.getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) url.openConnection();
            ACTIVE_REQUESTS.put(requestId, connection);
            if (CANCELLED_REQUESTS.contains(requestId)) {
                connection.disconnect();
                throw new InterruptedException("请求已取消");
            }
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(Math.min(30_000, timeoutMs));
            connection.setReadTimeout(timeoutMs);
            connection.setDoInput(true);
            connection.setDoOutput(true);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setFixedLengthStreamingMode(requestBytes.length);
            connection.setRequestProperty("Accept-Encoding", "identity");

            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                String value = headers.optString(name, "");
                if (value.isEmpty()) continue;
                if ("host".equalsIgnoreCase(name) || "content-length".equalsIgnoreCase(name)) continue;
                connection.setRequestProperty(name, value);
            }

            try (OutputStream output = connection.getOutputStream()) {
                output.write(requestBytes);
                output.flush();
            }

            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (input != null) {
                try (InputStream stream = input) {
                    byte[] buffer = new byte[8192];
                    int read;
                    int total = 0;
                    while ((read = stream.read(buffer)) >= 0) {
                        total += read;
                        if (total > MAX_RESPONSE_BYTES) {
                            throw new IllegalStateException("模型响应超过 8 MB，已停止读取。");
                        }
                        output.write(buffer, 0, read);
                    }
                }
            }

            JSObject responseHeaders = new JSObject();
            for (String name : new String[] { "content-type", "retry-after", "x-request-id" }) {
                String value = connection.getHeaderField(name);
                if (value != null) responseHeaders.put(name, value);
            }
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("body", output.toString(StandardCharsets.UTF_8.name()));
            result.put("headers", responseHeaders);
            call.resolve(result);
        } catch (Exception error) {
            String message = CANCELLED_REQUESTS.contains(requestId)
                ? "请求已取消"
                : "网络请求失败：" + safeMessage(error);
            call.reject(message, error);
        } finally {
            if (connection != null) connection.disconnect();
            ACTIVE_REQUESTS.remove(requestId);
            CANCELLED_REQUESTS.remove(requestId);
        }
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }
}
