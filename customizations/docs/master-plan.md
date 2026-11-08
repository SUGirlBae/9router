# Master Plan — Bản địa hoá provider Muse (muse.ai) vào 9router

> TL;DR (English): 9router already ships a `muse-web` provider, but its driver is a Playwright DOM
> scraper that only serves image/video. We measured the real muse.ai protocol from a plain Node
> client: bootstrap (`/api/session` → `/api/hatch/vm/wake` → `/api/hatch/token`) returns 200 from
> Node with no fingerprint spoofing, and `wss://hatch.metaaivm.com/v1/noise` completes the WebSocket
> upgrade from Node's built-in client. Content therefore flows over a **Noise-XX WebSocket + protobuf
> RPC**, not REST. This plan builds a Chromium-free Node driver for that tunnel, exposes it first as a
> sidecar registered as an `openai-compatible` provider node (no restart, no bundle patch), then
> optionally as an in-bundle executor with automatic fallback to the existing browser path.

**Mục tiêu:** gọi Muse qua `POST /v1/chat/completions` bằng **chính API key của 9router**, không cần Chromium, không cần mở trình duyệt, bền và miễn phí.

**Cấu trúc:** tài liệu này là mục lục. Chi tiết kỹ thuật nằm ở `spec.md` (protocol), `sdd.md` (thiết kế module), `tdd.md` (kiểm thử), `harness.md` (cách chạy), `check-list.md` (các cổng chặn), `progress.md` (nhật ký bằng chứng), `artifact-plan.md` (danh sách tệp).

---

## 1. Bối cảnh — ba sự thật đã đo được

1. **9router 0.5.112 đã có `muse-web`, nhưng là DOM scraper.** Module `20690` trong `chunks/5330.js`: mở `/thread/new`, chờ `[data-hatch-shell-hydration-state]="hydrated"`, gán value vào `<textarea>` qua React prototype setter, bấm Send, rồi đọc `innerText` của bubble cuối. Descriptor (`chunks/2598.js`) đặt `serviceKinds:["image","video"]` → **chat chưa từng được route**: `usageHistory` có 0 dòng muse, `requestDetails` 0/1000 dòng.
2. **Kho muse.ai không có REST chat.** Đo trực tiếp: gateway theo-VM (`<uuid>.metaaivm.com`) đóng hoàn toàn ở tầng HTTP/WS; chỉ có **LB host `hatch.metaaivm.com`** mở đường `/v1/noise`. Nội dung đi qua Noise-XX + protobuf RPC (`POST /chat/stream`, `GET /chat/history`, `POST /chat/subscribe`, `GET /media/raw/<path>`, `POST /approvals/{id}/decide`).
3. **Node client được chấp nhận.** `GET /api/session?vm_state=live` → 200 `status:"assigned"`; `POST /api/hatch/vm/wake` → 200 `{"status":"wake_requested"}`, VM đạt `RUNNING` sau 2.1 s; `POST /api/hatch/token` → 200 chứa **cả `token` và `notary_token`**; WS upgrade tới LB → **101 OPEN trong 923 ms** bằng `WebSocket` dựng sẵn của Node. `vm_type="hatch_vm"` (VM thường, **không phải** Confidential VM) → không cần notarised message 3, hết luôn rủi ro lớn nhất.

→ Không cần `curl_cffi`, không cần Python, không cần thư viện npm mới. `node:crypto` (X25519 + AES-256-GCM + HKDF-SHA256) dựng được Noise XX; protobuf wire format tự viết (~150 dòng).

## 2. Những gì **không** lấy từ hai repo được giao

| Repo | Thực chất | Kết luận cho ta |
|---|---|---|
| `czg86389-hub/muse2api` (anh chọn) | CDP + DOM scraping, **0** chuỗi `wss://`, chỉ gọi đúng 2 endpoint muse.ai như 9router | Không cho protocol. Cho **kinh nghiệm vận hành**: vòng đời cookie (`hatch_vml` ≈ 48 h, không gia hạn bằng cách dùng), taxonomi lỗi, phân biệt ảnh/video trong DOM, chống lấy lại ảnh upload |
| `www222fff/muse2api` | `HttpDriver.chat_stream` **raise 501**; TODO B1 "Direct HTTP protocol driver — Not started" | Không cho protocol. Cho **máy trạng thái hồ** đáng tin nhất (`AuthError→invalid`, `QuotaError→≥1 h`, `Timeout→không phạt`) và ánh xạ OpenAI + `/v1/responses` |
| `its-benjamin/muse2api-http` | Bridge **browserless** thật: Noise XX + protobuf + `protocol.json` 352 route | Đây là nguồn protocol chính. vẫn phải tự kiểm chứng từng byte với account của anh |

Từ chối rõ ràng: **không** dùng `tools/mailtm_otp.py` (đăng hàng loạt mail một lần để đẻ tài khoản) và **không** chạy `czg86389` như một dependency — repo đó có self-updater gọi `raw.githubusercontent.com`/`api.github.com` không xin phép và `POST /admin/repo/push` đẩy cây mã của máy anh lên repo người khác.

## 3. Các pha

| Pha | Kết quả chốt | Cổng phải qua | Ghi chú |
|---|---|---|---|
| **P0** | Bộ 8 tài liệu này | anh duyệt | viết trước mọi code, theo yêu cầu |
| **P1** | `muse-bridge.cjs` nói chuyện được với gateway: Noise XX → msg1/2/3 → `split()` → `POST /api/ping` nhận JSON | test mã hoá khớp vector Noise chính thức + fake-gateway | chữ ký byte là chỗ dễ sai nhất; làm riêng, đo riêng |
| **P2** | Một turn chat thật trả text qua SSE, có `[DONE]`, TTFB < browser baseline | `MUSE_LIVE=1` + **xin phép anh** (spend 1 tin nhắn) | hoàn thành turn = im lặng ≥2 s trên `/chat/history`, không phải 1 frame |
| **P3** | Sidecar `:20141` + đăng ký provider node `muse` → gọi được bằng API key 9router | `check-list.md` §C3 | **không** đụng bundle, **không** restart |
| **P4** | `muse-image` / `muse-video` qua cùng tunnel (`/media/raw`) | đo được asset thật | media **bắt buộc** phải có cổng riêng: repo cho thấy ảnh/video sinh trong VM, blob URL chết cùng trang |
| **P5** | Executor trong bundle + fallback Playwright | **RESTOP = quyết định của anh** | seam đã kiểm chứng: needle `,"muse-web":new y._5` đếm = 1 |

## 4. Rủi ro đã lượng hoá (đọc trước khi bật)

- **Song song không phải điểm mạnh của Muse.** Các repo đo: 1 request ≈ 5 s; **3 request đồng thời ≈ 20 s mỗi cái**; 10 đồng thời 33–95 s rồi timeout; thread lạnh 20–40 s cho chữ đầu tiên. Lý do: mỗi account = một VM trên trời, các hội thoại **tranh nhau trên cùng VM**. → Muse **không giải quyết** than phiền "nhiều sub-agent cùng lúc" của anh; `qd/qfmodel` vẫn là xe tăng. Muse hợp cho: 1 luồng hội thoại, ảnh/video, hoặc khi pool qoder hết credit. Muốn song song thật phải bỏ nhiều account muse.ai vào pool.
- **Rủi ro tài khoản là có thật.** `muse2api-http` ghi thẳng: *"Account safety and any risk of account bans are solely your own responsibility… private, individual personal self-hosting. NEVER expose it as an open public API."* Repo czg86389 ghiMuse là tài sản **Meta**. Ngoài ra `engine.py:799` cho biết **đăng nhập nơi khác hoặc risk control có thể đá session**. → chỉ chạy cá nhân, tại 127.0.0.1, và **kiểm tra `tunnelUrl` đang bật hay tắt trước khi thêm credential** (settings của 9router hiện có `tunnelUrl=https://…trycloudflare.com`).
- **Hết quota không đo được bằng API.** `protocol.json` 352 route **không có** route quota nào. Chỉ có: đọc chữ trong người trợ lý ("out of credits", "额度不足") và cào panel Settings→Usage. → router phải hiển thị "account nghi có vấn đề", đừng bịa số token còn lại.
- **`hatch_vml` ≈ 48 h và không gia hạn bằng việc dùng.** Tài khoản chết âm thầm sau ~2 ngày nếu không import lại. Không có login flow tự động ở bất kỳ repo nào.
- **`tools`/function-calling: không có trên wire.** czg86389 tắt mặc định vì *trợ lý Muse từ chối thẳng* in "pseudo tool call". → CLI agent (Claude Code / Qoder) gọi Muse sẽ **mất tool call**; chỉ hợp làm model hội thoại/ý tưởng.

## 5. Quyết định kiến trúc (đã chốt, kèm lý do)

1. **Node thuần, không dependency mới** — vì đo rồi: Muse nhận Node (mục 1.3). Python sidecar sẽ là một tiến trình + môi trường nữa phải nuôi, đi ngược ưu tiên "bền, dễ nuôi".
2. **Sidecar trước, in-bundle sau** — sidecar cho dùng ngay trong hôm nay qua cơ chế node `openai-compatible` (tiền lệ sống: node `9RouterWom` trỏ `https://womtech.io.vn/v1`), và **không đòi restart 9router**.
3. **Không dynamic-`require` trong bundle** — chunk factory của webpack là `(webpackRequire, module, exports)`, identifier `require` không có trong scope; seam đúng là `9r-net-keeper.js` (đã được `--require` vào `cli.js`) đặt `globalThis.__9rMuseWrap`, bundle chỉ thêm một ternary.
4. **Giữ nguyên Playwright executor làm đường lùi** — wrapper chỉ override `execute` (và `generateMedia` khi P4 xong); mọi thứ khác delegate. Driver gãy → router vẫn chạy như hôm nay.
5. **Session mặc định là stateless theo `x-muse-session`** — repo chứng minh nhiều client vô danh dính thread của nhau; mỗi CLI/agent phải có thread riêng, TTL 24 h.
6. **Chính sách approvals = `deny` mặc định** — agent Muse *dừng chờ* khi xin quyền (network egress, connector); không trả lời `/approvals/{id}/decide` là turn treo tới timeout. Router một người dùng thì từ chối là an toàn nhất.

## 6. Rollback

- **P1–P3:** xoá node `muse` (`DELETE /api/provider-nodes/[id]`) + tắt sidecar. Bundle không bị đụng → **không restart**.
- **P5:** khôi phục `chunks/5330.js` / `chunks/2598.js` từ `.pre-musehttp.bak`, xoá `%APPDATA%/9router/runtime/muse-web-http-executor.cjs` (loader trong keeper tự bất hoạt khi thiếu file), bỏ entry khỏi `reinstall-9router-fixes.js`, restart (có duyệt).

## 7. Nhật ký quyết định

| Ngày | Quyết định | Lý do / bằng chứng |
|---|---|---|
| 2026-11-03 | Scope = chat + image + video; protocol: repo trước rồi capture; kiến trúc: 2 pha | trả lời AskUserQuestion của anh |
| 2026-11-03 | Bỏ giả định "curl_cffi fingerprint là bắt buộc" | `probe-session.mjs`: undici h1 **và** node:http2 đều 200 `assigned` |
| 2026-11-03 | Bỏ giả định "chỉ 3 model id, wire không có model selector" — vẫn đúng, nhưng nguồn là repo, chưa phải wire | `czg86389 app.py:1566`: agent tự route, tự xưng **Koda** |
| 2026-11-03 | Chọn Noise-XX WS làm transport, không tìm REST nữa | `probe-gateway.mjs`: VM host đóng HTTP; LB mở `wss://…/v1/noise` → **101** |
| 2026-11-03 | Không cần nhánh Confidential-VM | `vm_type="hatch_vm"`, và `/api/hatch/token` trả sẵn `notary_token` |
