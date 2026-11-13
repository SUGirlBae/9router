# Walkthrough — Luồng hoạt động Dual-Instance `20128` ↔ `20130` & Fail-Over

## 1. Luồng Request từ Client qua `20128` → `20130` (`womtech.io.vn` fail-over)

```text
[1] Client (Claude Code / Cursor / Qoder / IDE)
       │  Gửi tới http://127.0.0.1:20128/v1 hoặc https://rr6g38g.abc-tunnel.us/v1
       ▼
[2] 9router Gốc (Port 20128, %APPDATA%\9router — DB trắng sạch)
       │  • Nhận request bằng mã nguồn upstream nguyên bản
       │  • Định tuyến theo node provider đã khai báo trong dashboard:
       │      Node `30`          : http://localhost:20130/v1        (prefix model `pc/`)
       │      Node `9RouterWom`  : https://rzz2wqk.abc-tunnel.us/v1 (prefix model `9RouterWom/`)
       │  • LƯU Ý: hiện `combos` = 0, nên CHƯA có fail-over tự động nào.
       │    Client phải gọi model id có prefix (`pc/<model>` hoặc `9RouterWom/<model>`);
       │    id trần sẽ không resolve. Muốn fail-over thật thì tạo combo trên dashboard 20128
       │    (Combo → 2 node trên, strategy `round-robin`/`failover`).
       ▼
[3] 9router-fork Custom (Port 20130, %APPDATA%\9router-fork — Bộ lọc điểm cuối)
       │  a) Ingress Scrubber (`src/sse/handlers/chat.js` -> `open-sse/handlers/chatCore.js`):
       │     • `sanitizeIngressHeaders(clientRawRequest.headers)` xóa mọi dấu vết hop trung gian
       │       do 20128 / Cloudflare tạo ra (`x-forwarded-*`, `x-real-ip`, `forwarded`, `via`,
       │       `cf-*`, `cdn-loop`, `x-9r-*`, `x-azure-*`, `x-fastly-*`, `akamai-*`, `x-render-*`,
       │       `x-deno-*`, các header cache/trace như `x-cache`, `x-varnish`, `fly-request-id`,
       │       `x-request-id`, `x-connection-id`, và `User-Agent` của hop `undici`/`node`).
       │     • Chỉ giữ header ngữ nghĩa an toàn (`authorization`, `x-api-key`, `anthropic-beta`,
       │       `x-session-id`, `x-opencode-session`, ...). Tên header được lowercase hóa.
       │     • `x-connection-id` bị bỏ khỏi `credentials.rawHeaders` NHƯNG pinning vẫn hoạt động:
       │       `src/sse/handlers/chat.js` đọc nó từ `request.headers` trước bước sanitize.
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
   - **Nâng cấp/custom `20130` (`9router-fork`)**: dùng `customizations/runtime/restart-rolling.ps1` (đã trỏ 20130) hoặc tắt/mở lại `9router-fork`.

## 3. CẢNH BÁO VẬN HÀNH — các thao tác "Update"/"Shutdown" của bản gốc

Bản upstream có sẵn cơ chế tự cập nhật: nút **Update** trên dashboard, `POST /api/version/shutdown`,
`POST /api/version/update`, và menu *Update* trong CLI đều quét **toàn máy** và `taskkill` mọi tiến trình
khớp `9router` / `next-server` / `cli.js`, cùng **mọi** `cloudflared.exe` và tray binary.

Trên `9router-fork` đã vá lại (`customizations/patches/patch-9r-fork-kill-scope.js`): chỉ kill tiến trình
chứa `9router-fork`, không đụng cloudflared toàn cục, và đọc `.mitm.pid` trong `%APPDATA%\9router-fork`.

Trên `20128` (bản gốc, không được sửa) thì KHÔNG vá được. Vì vậy:

- **TUYỆT ĐỐI KHÔNG bấm Update / Shutdown trên dashboard `20128`** và không chạy
  `POST /api/version/update`. Hành động đó sẽ giết `9router-fork`, giết cả hai tunnel
  (`rb54hwc` + `r6g38g`) và không tự khôi phục.
- Muốn nâng cấp `20128`: dừng bằng **tray icon → Exit** (chỉ dừng instance 20128), chạy
  `npm i -g 9router@latest --prefer-online`, rồi mở lại `9router`.
- Nếu fork đã bị giết nhầm: mở lại bằng `9router-fork` (dashboard 20130 → Tunnel → Enable nếu cần).
- Không bật **MITM** trên `20128`: cả hai instance dùng chung cổng MITM mặc định, sẽ tranh chấp.
