# Code Tree — Kiến trúc & Bản đồ Mã nguồn `9router-fork` (v0.5.119 Custom)

Cập nhật: 2026-11-13 · Base upstream: `v0.5.119` (`decolua/9router`) · Fork repo: `SUGirlBae/9router`

## 1. Bố cục chạy song song trên Windows

```text
C:\Users\Administrator\AppData\Roaming\
├── npm\
│   ├── 9router / 9router.cmd                 # Lệnh bản gốc (Port 20128)
│   └── node_modules\
│       ├── 9router\                          # 100% nguyên bản npm (npm i -g 9router@latest)
│       ├── 9router.bak-frozen-custom-0.5.119\# Bản đóng băng custom 20128 trước khi tách
│       └── 9router-fork\                     # Bản custom độc lập (Port 20130, name="9router-fork")
│           ├── cli.js                        # DEFAULT_PORT=20130, DATA_DIR=%APPDATA%\9router-fork
│           ├── src\cli\tray\autostart.js     # APP_NAME="9router-fork" -> Startup\9router-fork.vbs
│           └── app\                          # Build Next.js standalone + patches runtime
├── 9router\                                  # DATA_DIR bản gốc (20128)
│   ├── db\data.sqlite                        # DB trắng sạch dùng điều phối 20130 + womtech.io.vn
│   ├── db\data.sqlite*.bak-*                 # DB cũ bảo toàn nguyên trạng (KHÔNG xóa)
│   └── tunnel\state.json                     # shortId="r6g38g" -> https://rr6g38g.abc-tunnel.us
├── 9router-fork\                             # DATA_DIR bản custom (20130)
│   ├── bin\9router-fork(.cmd)                # Shim PowerShell trên User PATH (không bị npm đè)
│   ├── db\data.sqlite                        # Bản clone 100% (124 connections, 41 proxyPools...)
│   ├── runtime\9r-net-keeper.js              # DNS stale-if-error + qwen/kimi/muse driver loader
│   ├── runtime\webchat\{qwen-web,kimi-web}\  # Driver webchat rời
│   ├── runtime\muse\                         # Muse direct HTTP executor + pool
│   └── tunnel\state.json                     # shortId="b54hwc" -> https://rb54hwc.abc-tunnel.us
└── Microsoft\Windows\Start Menu\Programs\Startup\
    ├── 9router.vbs                           # Auto-start 20128 (--tray --skip-update)
    └── 9router-fork.vbs                      # Auto-start 20130 (--tray --skip-update -p 20130)
```

## 2. Cây mã nguồn custom trong `D:\9router` (so với `upstream v0.5.119`)

```text
D:\9router\
├── custom-server.js                          # Tích hợp Zero-Downtime Gateway + x-9r-real-ip
├── open-sse\
│   ├── config\
│   │   ├── appConstants.js                   # Prompt rewrites & config chống phát hiện IDE
│   │   └── providerModels.js                 # `aglock`: giữ presetSuffix (không bị tier ghi đè)
│   ├── executors\
│   │   ├── antigravity.js                    # Virtual device UA/2.31.1, cô lập sessionId/requestId,
│   │   │                                     # built-in tools pass-through, dynamic modelCeiling,
│   │   │                                     # proxy-aware refreshCredentials
│   │   ├── deepseek-web.js                   # Bổ sung hỗ trợ/xử lý web session & PoW
│   │   └── muse-web\session.js               # Sửa cookie __Host- cho muse.ai
│   ├── handlers\
│   │   ├── chatCore.js                       # Gắn sanitizeIngressHeaders vào credentials.rawHeaders
│   │   ├── imageProviders\antigravity.js     # Sinh ảnh Antigravity chuẩn profile
│   │   └── search\chatSearch.js              # Search model mặc định gemini-3.8-flash
│   ├── providers\
│   │   ├── capabilities.js                   # Full capabilities cho Gemini 4/3.8, Claude, Codex 6.1
│   │   ├── shared.js                         # ANTIGRAVITY_IDE_VERSION=2.31.1, cl=1012564305
│   │   └── registry\
│   │       ├── antigravity.js                # gemini-pro-agent(high), searchViaChat
│   │       ├── codex.js                      # gpt-6.1-sol[1m], gpt-6.1-terra[1m]
│   │       ├── qwen-web.js                   # [NEW] Đăng ký catalog qwen-web
│   │       └── index.js                      # Export registry + qwen-web
│   ├── services\
│   │   ├── antigravityDevice.js              # [NEW] Dynamic Virtual Device Profile per account
│   │   ├── latencyOrchestrator.js            # [NEW] Smart Latency Orchestrator & Circuit Breaker
│   │   ├── projectId.js                      # Lookup/cache projectId theo connection
│   │   ├── tokenRefresh.js & providers.js    # Refresh token qua proxyOptions của connection
│   │   └── usage\{antigravity-weekly,google}.js # Quota tracking per-account
│   ├── translator\
│   │   ├── concerns\thinkingUnified.js       # Chuẩn hóa thinking/reasoning giữa client & upstream
│   │   ├── formats\maxTokens.js              # Bỏ trần cứng 64k cho model hỗ trợ 128k
│   │   └── request\{claude-to-openai,openai-to-claude,openai-to-gemini}.js
│   └── utils\
│       ├── ingressHeaderSanitizer.js         # [NEW] Xóa sạch dấu vết proxy/hop/20128 ở tầng nhận 20130
│       └── proxyFetch.js                     # `ecdh`: NINEROUTER_TLS_ECDH_CURVE || "X25519:P-256:P-384"
├── src\
│   ├── app\(dashboard)\dashboard\providers\
│   │   ├── [id]\page.js                      # `providerBoundCount` + Fetch Models universal
│   │   ├── [id]\ConnectionRow.js             # Badge + tooltip bound count, overscroll-contain, stopPropagation
│   │   ├── [id]\AddApiKeyModal.js            # Hiển thị `(count)` trên Select Proxy Pool
│   │   └── components\{ConnectionsCard,WebLoginButton}.js
│   ├── app\api\
│   │   ├── models\test\ping.js               # AbortSignal.timeout(60000)
│   │   ├── providers\[id]\models\route.js    # Fallback static catalog cho mọi provider
│   │   └── proxy-pools\
│   │       ├── route.js & [id]\route.js      # Auto-detect type (netlify/cloudflare/vercel/deno) theo URL
│   │       └── {cloudflare,deno,netlify,vercel}-deploy\route.js # STRIP_PREFIXES/STRIP_EXACT + Netlify Public 401 guard
│   ├── lib\
│   │   ├── network\netlifyRelay.js           # Netlify relay bundle strip toàn bộ IP/proxy headers
│   │   └── tunnel\{cloudflare,tailscale}\manager.js # Đọc PORT động thay vì hardcode 20128
│   ├── mitm\
│   │   ├── antigravityIdeVersion.js          # Chuẩn hóa version IDE Antigravity
│   │   ├── manager.js                        # Tránh setx NODE_EXTRA_CA_CERTS, dọn registry Windows
│   │   ├── server.js                         # Tích hợp telemetrySinkhole + version 2.31.1
│   │   └── telemetrySinkhole.js              # [NEW] Hấp thụ telemetry/metrics Google trả 200 OK
│   └── sse\
│       ├── handlers\chat.js                  # Đọc header x-connection-id -> preferredConnectionId
│       └── services\auth.js                  # Pinned sticky + latencyOrchestrator + circuit breaker
└── customizations\
    ├── gateway\9r-zero-downtime-gateway.js   # Master gateway + mid-stream abort drain fix
    ├── runtime\9r-net-keeper.js              # DNS keeper + __9rQwenExec / __9rKimiExec / __9rMuseWrap
    └── patches\                              # Các script vá bundle cho qoduck, qd-suffix, webchat...
```
