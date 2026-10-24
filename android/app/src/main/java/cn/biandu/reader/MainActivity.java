package cn.biandu.reader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(BianduBackupPlugin.class);
        registerPlugin(BianduFocusPlugin.class);
        registerPlugin(BianduNetworkPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        BianduNetworkPlugin.cancelAll();
        BianduFocusPlugin.releaseIfOwned(this);
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        BianduFocusPlugin.resumeIfRequested(this);
    }
}
