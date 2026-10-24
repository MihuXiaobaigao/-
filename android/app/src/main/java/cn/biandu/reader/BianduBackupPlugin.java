package cn.biandu.reader;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "BianduBackup")
public class BianduBackupPlugin extends Plugin {
    @PluginMethod
    public void saveText(PluginCall call) {
        String content = call.getString("content");
        String filename = call.getString("filename", "biandu-backup.json");
        if (content == null || content.isEmpty()) {
            call.reject("备份内容为空。");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "saveResult");
    }

    @PluginMethod
    public void saveBinary(PluginCall call) {
        String content = call.getString("content");
        String filename = call.getString("filename", "biandu-document");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (content == null || content.isEmpty()) {
            call.reject("待保存文件为空。");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "saveBinaryResult");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("已取消保存备份。");
            return;
        }

        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (uri == null) {
            call.reject("系统没有返回可写入的备份位置。");
            return;
        }

        String content = call.getString("content", "");
        try (OutputStream stream = getActivity().getContentResolver().openOutputStream(uri, "wt")) {
            if (stream == null) throw new IllegalStateException("无法打开备份文件");
            stream.write(content.getBytes(StandardCharsets.UTF_8));
            stream.flush();
            JSObject response = new JSObject();
            response.put("uri", uri.toString());
            response.put("filename", call.getString("filename", "biandu-backup.json"));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("保存备份失败：" + error.getMessage(), error);
        }
    }

    @ActivityCallback
    private void saveBinaryResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("已取消保存文件。");
            return;
        }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (uri == null) {
            call.reject("系统没有返回可写入的位置。");
            return;
        }
        String content = call.getString("content", "");
        try (OutputStream stream = getActivity().getContentResolver().openOutputStream(uri, "wt")) {
            if (stream == null) throw new IllegalStateException("无法打开目标文件");
            stream.write(Base64.decode(content, Base64.DEFAULT));
            stream.flush();
            JSObject response = new JSObject();
            response.put("uri", uri.toString());
            response.put("filename", call.getString("filename", "biandu-document"));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("保存文件失败：" + error.getMessage(), error);
        }
    }
}
