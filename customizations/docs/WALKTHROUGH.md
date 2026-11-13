# Walkthrough — Luồng hoạt động Dual-Instance `20128` ↔ `20130` & Fail-Over

## 1. Luồng Request từ Client qua `20128` → `20130` (`womtech.io.vn` fail-over)

```text
[1] Client (Claude Code / Cursor / Qoder / IDE)
       │  Gửi tới http://127.0.0.1:20128/v1 hoặc https://rr6g38g.abc-tunnel.us/v1
       ▼
[2] 9router Gốc (Port 20128, %APPDATA%\9router — DB sạch)
       │  • Nhận request bằng mã nguồn upstream nguyên bản
       │  • Định tuyến qua Combo Round-Robin / Fail-Over:
       │      Primary node : http://127.0.0.1:20130/v1 (hoặc https://rb54hwc.abc-tunnel.us/v1)
       │      Backup node  : https://womtech.io.vn/v1 (kích hoạt tự động khi 20130 đang restart/upgrade/lỗi)
       ▼
[3] 9router-fork Custom (Port 20130, %APPDATA%\9router-fork — Bộ lọc điểm cuối)
       │  a) Ingress Scrubber (`src/sse/handlers/chat.js` -> `open-sse/handlers/chatCore.js`):
       │     • `sanitizeIngressHeaders(clientRawRequest.headers)` xóa mọi dấu vết hop trung gian
       │       do 20128 / Cloudflare tạo ra (`x-forwarded-*`, `x-real-ip`, `forwarded`, `via`,
       │       `cf-*`, `cdn-loop`, `x-9r-*`, `x-request-id`, `x-connection-id`, `user-agent` của undici/node).
       │     • Chỉ giữ header ngữ nghĩa an toàn (`anthropic-beta`, `x-session-id`, `x-opencode-session`...).
       │  b) Account & Proxy Orchestrator (`src/sse/services/auth.js` + `latencyOrchestrator.js`):
       │     • Tôn trọng `x-connection-id` nếu client pin account; giữ sticky session; áp circuit breaker.
       │     • Chọn proxy pool riêng của account (strict proxy cho Antigravity/Cloudflare/Vercel/Netlify/Deno).
       │  c) Anti-Abuse & Protocol Egress (`open-sse/executors/antigravity.js` + `proxyFetch.js` + Relay):
       │     • Sinh `antigravity/hub/2.31.1 (...; cl=1012564305; ...)` ổn định theo từng account.
       │     • Cô lập `conversationId` / `trajectoryId` / `sessionId` theo `accountKey` để không lộ chéo giữa các nick.
       │     • `getModelUpstreamId` giữ preset thinking khóa trên tên model (`aglock`).
       │     • `proxyFetch` dùng `X25519:P-256:P-384` tương thích DPI & TLS.
       │     • Relay worker (CF/Vercel/Netlify/Deno) tiếp tục strip toàn bộ `STRIP_PREFIXES`/`STRIP_EXACT` trước khi chạm API nhà cung cấp.
       │     • Nếu bật MITM: `telemetrySinkhole.js` chặn các endpoint analytics/metrics trả `200 OK` giả tại chỗ.
```

## 2. Luồng khởi động & quản trị độc lập (`9router` vs `9router-fork`)

1. **Khởi động cùng Windows**:
   - `Startup\9router.vbs` gọi `node ...\npm\node_modules\9router\cli.js --tray --skip-update` → giữ cổng `20128` + tunnel `r6g38g`.
   - `Startup\9router-fork.vbs` gọi `node ...\npm\node_modules\9router-fork\cli.js --tray --skip-update -p 20130` → giữ cổng `20130` + tunnel `b54hwc`.
2. **Điều khiển độc lập từ PowerShell**:
   - Gõ `9router`: chỉ đọc `%APPDATA%\9router\launcher.pid`, chỉ quản cổng `20128` và khay hệ thống Port `20128`.
   - Gõ `9router-fork`: gọi shim `%APPDATA%\9router-fork\bin\9router-fork.cmd` với `DATA_DIR=%APPDATA%\9router-fork`, chỉ đọc `%APPDATA%\9router-fork\launcher.pid`, chỉ quản cổng `20130` và `cloudflared` của `20130`, khi chọn *Hide to Tray* chỉ ghi đè `Startup\9router-fork.vbs`.
3. **Nâng cấp an toàn**:
   - **Cập nhật bản gốc `20128`**: chạy `npm i -g 9router@latest --prefer-online`. Shim `9router-fork.cmd`, thư mục `npm\node_modules\9router-fork`, và `%APPDATA%\9router-fork` hoàn toàn không bị đụng.
   - **Nâng cấp/custom `20130` (`9router-fork`)**: trong lúc `20130` build/restart, `20128` tự động fail-over traffic sang `womtech.io.vn` nên client không bị đứt kết nối.
