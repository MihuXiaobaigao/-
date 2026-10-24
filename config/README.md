# 内置模型配置

`builtin-models.local.json` 是本机私有配置，已被 `.gitignore` 排除。`npm start`、`npm test` 和 `npm run build:web` 会据此生成 `src/web/builtin-models.generated.js`，再把模型档案打进 APK/PWA。

内置密钥在首次启动后会使用设备本机 AES-GCM 密钥加密存入 IndexedDB。由于客户端应用必须能把默认密钥注入首次启动环境，任何拿到安装包的人仍可能从包内提取这份初始配置；如果要公开分发，应改用你自己的服务端代理并从安装包移除固定密钥。
