# TDD — Kiểm thử

**Luật của bộ test này:** không test nào được mở mạng, không test nào chạm account thật, không test nào in credential. Live test tồn tại, nhưng ở file khác và phải xin cờ.

Khuôn: `../test-lanes.js` — `node:http`/`ws` giả trong tiến trình + fixture + assertion có nhãn, in `PASS/FAIL` rồi `ALL PASS`, `process.exitCode` phản ánh kết quả.

## 1. Thứ tự đỏ–xanh

| Bước | Làm gì | Vì sao thứ tự này |
|---|---|---|
| 1 | `lib/noise.cjs` + vector chính thức | crypto sai thì mọi thứ sau vô nghĩa; đo được mà không cần Muse |
| 2 | `lib/pb.cjs`/`wire.cjs` + golden bytes | framing là chỗ treo turn khó tìm nhất |
| 3 | `fake-gateway.mjs` (server cùng lib) | cho phép test toàn bộ semantic offline |
| 4 | `lib/session.cjs` | wake-trap (403 ≠ chết) phải có test trước khi ai đó đoán lại |
| 5 | `lib/history.cjs` | quy tắc "im lặng 2 s" và chống cắt cụt |
| 6 | `muse-bridge.chat()` | R1/R2/R4/R5/R13 |
| 7 | `pool.cjs` | R6 + máy trạng thái cooldown |
| 8 | `lib/media.cjs` + `image()/video()` | R10/R11/R12 |
| 9 | `sidecar.cjs` | OpenAI shape, auth, streaming |
| 10 | `test-muse-live.js` (gated) | đối chiếu reality |
| 11 | P5 patch + fallback | R8 |

## 2. Inventory

### N — Noise (`test-noise.js`)
- **N1** round-trip: initiator + responder cùng `lib/noise.cjs`, 3 message, `split()` → hai chiều encrypt/decrypt đúng, `handshakeHash` hai bên bằng nhau.
- **N2** khớp `Noise_Pattern.txt` cho `Noise_XX_25519_AESGCM_SHA256` fallback pattern (`cs`, `e`, `s`, `handshake_hash`, payload rỗng) — neo độc lập với repo.
- **N3** msg1 **bắt buộc mang payload** (32-byte client nonce): assert `writeMessage1(EMPTY)` ≠ `writeMessage1(NONCE)` và hash sau msg1 phụ thuộc payload (`h` đã mix trước khi encrypt payload).
- **N4** nonce = `00000000 || BE64(counter)`; counter mỗi chiều độc lập sau `split()`; 200 frame liên tiếp không lặp nonce.
- **N5** msg2 ngắn hơn 96 byte → throw `MuseUpstreamError`, **không** crash.
- **N6** tag AES-GCM bị sửa → throw, không trả rác.

### W — Wire (`test-wire.js`)
- **W1** encode/decode `ApplicationRequest` khớp golden bytes (verb/path/headers/body/end_body).
- **W2** `ServiceRequest` lồng `ServiceFrame` đúng cấp bậc (3 lớp, theo §4.4 `sdd`).
- **W3** outbound 200 KiB → nhiều frame, `chunk_id` đổi giữa message, `chunk_index`/`total_chunks` đúng.
- **W4** **inbound một chunk 8 MiB phải được chấp nhận** (bất đối xứng có chủ đích) — nếu code từ chối vì > 48 KiB là fail.
- **W5** `Reset` encode với `code=1` + reason, pinned service daemon.
- **W6** reassembler với frame đến lộn thứ tự / thiếu → không bao giờ trả buffer cụt; quá `MAX_ASSEMBLY_BYTES` → throw.

### S — Session (`test-session.js`, fake `muse.ai` trên `node:http`)
- **S1** `renew()` 200 `assigned` và **xoay `hatch_sess`+`hatch_vml`** → jar mới được persist (atomic, throttle 30 s, force sau `/api/session`).
- **S2** wake trả **403** nhưng `/api/session` sau đó báo `RUNNING` → coi là **thành công** (đây chính là bug production mà hai repo đã trả giá).
- **S3** wake trả 200 nhưng session vẫn `SUSPENDED` → `waitRunning` timeout → `timeout` (không đổi trạng thái account).
- **S4** 401 → `MuseError("auth")`, **không retry**, account → `invalid`.
- **S5** 403 trên `/api/session` → `access`, cooldown 600 s, và **giữ nguyên** `expiresAt` cũ (không ảo gia hạn).
- **S6** `status != "assigned"` → `upstream`, không ghi đè snapshot tốt trước đó.
- **S7** `tokens()` lấy `notary_token` ngay trong response `/api/hatch/token` (đo thật), và **sống được** khi `noise-notary-token` fail (notary là optional).

### H — Turn semantics (`test-history.js` qua fake-gateway)
- **H1** một turn → ≥2 delta và một `done` (R2), thứ tự bảo toàn, text ghép lại == text fixture.
- **H2** text vẫn dài → **không** kết thúc; hết dài nhưng < 2.0 s → chưa kết thúc; ≥ 2.0 s → kết thúc (chống cắt cụt turn dài).
- **H3** event có `reply_to_message_id` bị bỏ qua — không lấy nhầm reply làm câu trả lời.
- **H4** `message.assistant` rỗng + chỉ có text từ `delta.message_done.transcript…` → vẫn lấy được theo đúng fallback chain `display_text→text→payload.*`.
- **H5** `/chat/stream` ack timeout → **vẫn** đọc được trả lời qua `/chat/history` (ack là best-effort).
- **H6** approval treo xuất hiện giữa turn → policy `deny` decide, turn đi tiếp; policy `off` → không gọi `/approvals` (đường fast-path).
- **H7** `signal.abort` giữa poll → thoát < 250 ms, có gửi `Reset`, **không** để lại stream mở.

### B — Bridge / OpenAI mapping (`test-muse-bridge.js`)
- **B1** `POST /v1/chat/completions` non-stream → `choices[0].message.content` không rỗng, `object:"chat.completion"`, `finish_reason:"stop"`.
- **B2** stream → các `chat.completion.chunk` + `data: [DONE]`; **không bao giờ** 200 rỗng (R4/R5 chống lại chính ca này).
- **B3** `muse-video` dùng cho chat → **400** nêu rõ kind (R-spec §6).
- **B4** model lạ → 400 liệt kê id khả dụng (T9).
- **B5** `tools` có thật (client trông đợi FC) → lỗi `unsupported` rõ ràng, **không** im lặng bỏ.
- **B6** `sessionKey` khác nhau → `session_id` upstream khác nhau (R13); không key → `default`, và hai caller khác nhau **không** đọc lẫn nhau.
- **B7** message có `content[]` image → `items[].image` với `mime_type`/`data_base64`/`filename`.
- **B8** wall-time một turn fixture < 250 ms (chứng minh không `sleep` — R3).

### P — Pool (`test-pool.js`, 3 account giả)
- **P1** 8 turn song song với 3 account → không hai turn nào dùng **cùng** `session_id`/node của một account đồng thời (R6, và là điểm deadlock VM thật).
- **P2** `QuotaError` → account `cooling ≥3600 s`, turn tự xoay sang account khác **nếu chưa emit ký tự nào**.
- **P3** đã emit rồi → **không** failover ngầm (đạo đức stream); trả lỗi giữa dòng.
- **P4** `AuthError` → `invalid` vĩnh viễn cho tới khi re-import; `healthz()` vẫn không lộ cookie.
- **P5** hết mọi account → 503 + `Retry-After`, và `pool.cjs` **không** tự đặt lại state.

### M — Media (`test-media.js`)
- **M1** image fixture → `[{b64,mime}]` **là mảng**, mime `image/png` — đúng shape mà `chunks/9128.js` unpack `[V]`.
- **M2** video: poll trạng thái job → chỉ nhận **nguồn video thật** (`.mp4/.webm/.mov` hoặc `hasVideo`), **từ chối poster/cover** (bug thật #13/#14/#18 của repo).
- **M3** kết quả trùng sha256 với ảnh upload → bỏ (chống "trả lại chính ảnh mình đưa").
- **M4** poll quá `ceiling` (video 600 s, ảnh 240 s, scale theo fixture) → `timeout`, **không** vòng lặp vô hạn.
- **M5** `/media/raw` fail → fallback `/fs/raw` rồi mới lỗi; lỗi không bao giờ trả file dở.
- **M6** `signal.abort` giữa chờ → dừng poll, không mồ côi job (R11).

### Y — Sidecar (`test-sidecar.js`)
- **Y1** thiếu/sai bearer → 401; **Y2** `GET /v1/models` đúng OpenAI list 3 id; **Y3** `/healthz` **không** chứa chuỗi cookie/token/`vm_id` (quét bằng regex credential); **Y4** bind `127.0.0.1` (assert địa chỉ listen), và **Y5** chỉ ra `EADDRINUSE` rõ ràng nếu port 20141 bận.

### X — Executor trong bundle (P5)
- **X1** wrapper override `execute`, gọi thẳng `executor.execute(ctx)` khi driver throw → **R8** (fallback, không failure).
- **X2** `NINEROUTER_MUSE_HTTP=0` → trả đúng instance Playwright gốc, không import driver.
- **X3** thiếu file driver → keeper **im lặng** bỏ qua, 9router khởi động bình thường (đây là gate an toàn: driver gãy không được chặn router).
- **X4** installer idempotent: chạy 2 lần → lần 2 in `already applied`, needle count vẫn 1, backup không bị ghi đè.

## 3. Gate trước khi đụng account thật

`node muse/test-muse-bridge.js && node muse/test-noise.js && node muse/test-wire.js && node muse/test-session.js && node muse/test-history.js && node muse/test-pool.js && node muse/test-media.js && node muse/test-sidecar.js` → **ALL PASS**, rồi mới tới `test-muse-live.js`, và live luôn cần `MUSE_LIVE=1` + sự đồng ý của anh.

---

## Ban do test ID (ke hoach -> thuc te), chay 2026-11-03

```
node muse/test-noise.js      6 case   (N1..N6)   vector flynn byte-exact hai chieu
node muse/test-wire.js       6 case   (W1..W6)   ping byte-exact + chunk + varint edge
node muse/test-gateway.js   12 case   (S1..S12)  = T1..T14 cung ung:NDJSON stream, status map, abort, reset, doc lap
node muse/test-bridge.js    15 case   (B1..B15)  = turn semantics (H1..H7) + pool (P1..P5) + approval (B14/B15)
node muse/test-media.js      7 case   (M1..M7)   = M/T11..T14: shape [b64,mime], n, abort, cap, refusal
node muse/test-executor.js  11 case   (X1..X11)  = fallback browser khi direct loi, disable bang env, Proxy forward
node muse/test-sidecar.js     5 case   (Y1..Y5)   = 401 bearer, khong lo cookie, bind 127.0.0.1, 404, loi co kiem chung
node muse/parallel-muse.js                       = P1..P5 song song (offline 8/8 ~98ms; live can 6 tin nhắn)
```

Khoang trong con lai, co chu dich va co ly do:
- **Y2 models list**: thuat toan `/v1/models` khong do offline vi no Goi muse.ai; da do **live** (`auto/auto` + `muse-chat`).
- **Live video**: chua do (anh da do: 15334 B WEBP qua `/v1/images/generations`).
- **Live parallel**: chua do vi ton 6 tin nhắn; tranh that cua Muse la mot VM/account (da do trong master-plan).

Gate truoc khi go live: **toan bo 61 case offline phai xanh** (dang xanh, 2026-11-03).
