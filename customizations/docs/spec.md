# Spec — Muse (muse.ai) qua 9router

Mỗi dòng protocol mang một nhãn độ tin, và driver **không được gửi** request nào chỉ có nhãn `INFERRED` cho tới khi nó được xác nhận bằng dữ liệu thật từ account của anh:

- **[V]** — đo trực tiếp từ account của anh, script nằm trong `muse/`, chạy lại được.
- **[I]** — lấy từ `its-benjamin/muse2api-http` (đọc mã nguồn, không chạy lại). Cần xác nhận.
- **[H]** — heuristic/suy đoán từ hành vi app, các repo cũng chỉ đoán.

---

## 1. Yêu cầu chức năng

| ID | Yêu cầu | Nghiệm thu |
|---|---|---|
| R1 | Gọi `POST /v1/chat/completions` với **API key của 9router**, model `muse/muse-spark` | `gw-check.js` trả text không rỗng, HTTP 200 |
| R2 | Stream thật sự từng mảng (≥2 delta rồi `[DONE]`), không phải một blob cuối | `test-muse-bridge.js` T1 |
| R3 | Không Chromium, không DOM, không `sleep` cố định trong một turn | T10 (< 250 ms với fixture) |
| R4 | Hết hạn auth → lỗi có type `auth` (HTTP 401), **không bao giờ** trả 200 rỗng | T3, T5 |
| R5 | Hết quota → type `quota` (429), phân biệt được với `auth` | T4 |
| R6 | Nhiều account muse.ai xoay vòng độc lập, có cooldown theo loại lỗi | T4, T8 |
| R7 | Pha 1 **không** restart 9router | check-list §C3 |
| R8 | Mọi lỗi bất ngờ → rơi về executor Playwright cũ, không phải failure | T-fallback |
| R9 | Mỗi turn hiện trong `requestDetails` / `usageHistory` của 9router | SQL check |
| R10 | `POST /v1/images/generations` trả `{b64,mime}` đúng hình dạng 9router mong đợi | T11 |
| R11 | `POST /v1/videos` hỗ trợ chờ dài; client ngắt thì **hủy job**, không bỏ孤儿 | T12 |
| R12 | Media vẫn chạy bằng đường cũ khi đường trực tiếp chưa xong | bật `NINEROUTER_MUSE_HTTP=0` mà vẫn ra ảnh |
| R13 | Mỗi client/agent có thread riêng (mặc định stateless theo `x-muse-session`), không ai đọc trả lời của ai | T9 |
| R14 | Approval xin quyền của agent: **từ chối theo mặc định**, có knob `off\|deny\|allow_once\|allow_session` | T15 |

**Non-goals:** N1 không tự đăng nhập/tự đẻ tài khoản (không có login flow nào, và `mailtm_otp.py` là thứ ta cố ý không kế thừa); N2 không bán/mở API công khai; N3 không giả vờ có token usage thật (Muse không báo, ta tổng hợp số 0 và nói rõ); N4 không giả vờ chọn được model (wire không có field model); N5 không làm function-calling (xem §6).

## 2. Bootstrap — `[V]` toàn bộ mục này

Bốn request HTTPS tới `muse.ai`, cookie-auth, chạy được bằng `fetch` thường của Node:

```
GET  https://muse.ai/api/session?vm_state=live         [V] 200
POST https://muse.ai/api/hatch/vm/wake                 [V] 200 {"status":"wake_requested"}
POST https://muse.ai/api/hatch/token                   [V] 200 {token, notary_token}
POST https://muse.ai/api/hatch/noise-notary-token      [V] 200 {notaryToken}
```

`/api/session` trả về (đo trên account của anh, đã che giá trị định danh):

```json
{ "status": "assigned", "vm_selection": {"revision": 2, "override": null, "selectedMigrationSource": null},
  "vm_id": "<36>", "endpoint_url": "<56>", "vm_name": "<36>",
  "vm_state": "SUSPENDED | RUNNING", "vm_type": "hatch_vm",
  "replaced_vm_id": null, "migration_state": null, "replace_attempt_id": null,
  "vm_state_source": "live", "vms": [ ... ] }
```

Ba điều rút ra từ chính response này, không repo nào ghi đủ:

1. **`hatch_sess` VÀ `hatch_vml` bị xoay lại** trên mỗi lần gọi (`Set-Cookie` quan sát được) → phải ghi jar ngược vào pool, nếu không pool chết âm thầm sau ~2 ngày. `[V]`
2. **`vm_type="hatch_vm"`** → account này là VM thường, **không** phải Confidential VM. Không cần `MUSE_CVM_RV_KEY`, không cần notarised message 3. `[V]`
3. **`endpoint_url` là host nội bộ** (`<uuid>.metaaivm.com`), **không** tiếp cận được từ ngoài: mọi HTTP/WS trực tiếp tới nó fail ở tầng kết nối. Nó chỉ là tham số `vmAddress` khi xin token. `[V]`

`POST /api/hatch/vm/wake` body `[V]`: `{"vm_id": <từ session>, "retry_count": 0, "connect_attempt_id": <uuidv4>}`.

**Quy tắc chấm Wake (bẫy đã biết):** *không* xử mã trạng thái của chính wake — muse.ai trả **403 cho VM đã RUNNING** `[I]`. Sau khi gửi wake, **poll `/api/session` tới khi `vm_state=="RUNNING"`**. Đo thật: `SUSPENDED → RUNNING` trong **2.1 s** `[V]`.

Headers gửi đi `[V]` (Muse chấp nhận đúng nguyên bộ này từ Node):

```
Accept: */*            Accept-Language: en-US,en;q=0.9
Origin: https://muse.ai   Referer: https://muse.ai/thread/new
Sec-Fetch-Site: same-origin  Sec-Fetch-Mode: cors  Sec-Fetch-Dest: empty
User-Agent: Chrome/140  Cookie: <jar>
Content-Type: application/json   (chỉ khi có body)
```
Không có CSRF token, không có `x-hatch-*`, không có `Authorization` phía muse.ai. Cookie **là toàn bộ** credential `[V]`.

## 3. Credentials

| Cookie | Vai trò | Đời sống | Bắt buộc? |
|---|---|---|---|
| `hatch_sess` | đăng nhập | ~30 ngày `[I]` | **có** — một mình nó là điều kiện cần `[V]` |
| `hatch_vml` | token workspace | **~48 h, không gia hạn bằng việc dùng** `[I]` | không, nhưng **quyết định tuổi account** |
| `hatch_gw` | routing cache | ~1 năm `[I]` | không (bị xoay bởi `/api/hatch/token` — ta quan sát `[V]`) |
| `hatch_native_auth_device` | id thiết bị, khách ẩn danh cũng có | ~30 ngày `[I]` | không |
| `__Host-*` (vd `__Host-hatch_one_tap`) | host-only | — | import hết; **không** được set kèm attribute `Domain` |

Credential hiện đã nằm sẵn trong 9router (connection `muse-web`, `testStatus:"active"`, 1523 ký tự, mở đầu `__Host-hatch_one_tap=`) `[V]` → **không** phải xin anh dán lại cookie, chỉ đọc ra dùng.

## 4. Transport nội dung — Noise-XX WebSocket + protobuf RPC

### 4.1 Tunnel `[V]`/`[I]`

```
wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…&app_id=hatch-web&request_id=<uuid>[&notary_token=…]
```
- **Node kết nối được**: `WebSocket` dựng sẵn trả **101 OPEN trong 923 ms**, giữ mở 3 s, server **không** gửi frame nào — đúng với handshake initiator-first `[V]`.
- `app_id=hatch-web`, `LB host hatch.metaaivm.com`, path `/v1/noise` `[I]` (các repo móc từ Next.js bundle; ta nối thành công nên ba giá trị này coi như đúng).
- Env override: `MUSE_LB_HOST`, `MUSE_WS_PATH`, `MUSE_APP_ID`.
- Headers upgrade: `Origin: https://muse.ai`, `Sec-Fetch-Mode: websocket`, **`Sec-Fetch-Site: cross-site`** (vì `metaaivm.com ≠ muse.ai`) `[I]`.
- **Không có surface HTTP nào trên gateway**: `GET /health`, `POST /api/ping` fail ở tầng kết nối `[V]` → không có đường tắt bỏ Noise.

### 4.2 Noise `[I]`

`Noise_XX_25519_AESGCM_SHA256`; nonce = 4 byte 0 + counter 8 byte big-endian; `EMPTY_AD = b""` cho mọi data frame; msg1 mang `client_nonce` 32 byte **bắt buộc có payload** (msg1 rỗng sẽ hỏng vì hash binding); msg2 ≥ 96 byte; `split()` cho `tx`/`rx`.
VM thường: payload msg2 là attestation blob → **log rồi bỏ qua**, `message3_payload = b""` `[I]`.

### 4.3 Framing protobuf `[I]`

```
NoiseTransportFrame { int64 chunk_id=1; uint32 chunk_index=2; uint32 total_chunks=3; bytes payload=4; }
ServiceRequest  { ServiceType service=1; bytes payload=2; }   ServiceResponse { bytes payload=1; }
ServiceFrame    { int64 stream_id=1; oneof { ApplicationRequest request=2; ApplicationResponse response=3;
                                             BodyChunk body_chunk=4; Reset reset=5; } }
ApplicationRequest  { string verb=1; string path=2; repeated Header headers=3; bytes body=4; bool end_body=5; }
ApplicationResponse { int32 status=1; repeated Header headers=2; bytes body=3; bool end_body=4; }
BodyChunk { bytes data=1; bool end_body=2; }  Header { string key=1; string value=2; }  Reset { Code code=1; string reason=2; }
ServiceType: daemon=0, sentinel=1, vault=2, authd=3
```
Outbound split 48 KiB; **inbound phải rộng lượng** (gateway gửi message lớn thành một chunk; chối là turn treo): cap assembly 16 MiB `[I]`.
`stream_id` tăng dần; **phải gửi `Reset` khi ngừng đọc**, không thì stream rò `[I]`; Reset envelope luôn pinned `service=daemon` kể cả stream sentinel `[I]`.
Headers trong mỗi RPC stream (nằm **trong** protobuf, không phải HTTP): `Content-Type: application/json`, `x-request-id: <uuid>`, `x-app-id: hatch-web`, `Accept-Language` `[I]`.

### 4.4 Route table (phần ta dùng) `[I]`

| Mục đích | Verb | Path | service |
|---|---|---|---|
| gửi một turn | `POST` | `/chat/stream` | daemon |
| đọc trả lời (đường tin cậy) | `GET` | `/chat/history?limit=60&session_id=…` | daemon |
| stream delta thời gian thực | `POST` | `/chat/subscribe` | daemon |
| khai báo node (routing hint, được phép fail) | `POST` | `/api/nodes/register` | daemon |
| khai báo khả năng render | `POST` | `/client/register-capabilities` | daemon |
| lấy file ảnh/video | `GET` | `/media/raw/<path>` → fallback `/fs/raw/<path>` | daemon |
| xin quyền | `GET` `/approvals`, `GET` `/approvals/{id}`, `POST` `/approvals/{id}/decide` | **sentinel** |
| giữ sống | `POST` `/api/ping` | daemon |
| huỷ turn (bỏ ngỏ, chưa dùng) | `POST` `/chat/cancel` | daemon |

## 5. Body một turn chat `[I]`

```json
{ "items": [ {"type":"text","text":"<prompt>"} ], "message": "<prompt>",
  "node_id": "<uuid4 client>", "capabilities": ["chat_cancel","delta_stream",
    "custom_reactions","custom_reactions_facebook_thumbs_up_v1"],
  "session_id": "<uuid4 per conversation>", "timezone": "UTC",
  "metadata": {"thread_is_dictation_used": false} }
```
`message` **trùng** `items[0].text` (cả hai đều gửi). `session_id` là **UUID do client tự sinh** — muse.ai nhận UUID mới mà không cần `/session/start` `[I]`. Không có field `model`, không có field `stream` (streaming mang tính cấu trúc: `end_body` + `BodyChunk`).

**Phản hồi**: event `message.user` (echo), `message.assistant` (bản chỉnh, có `message_id`/`reply_to_message_id`/`ts_ms`), `delta.text_append`, `delta.message_done`, `delta.presentation` (mang ảnh/video). Lấy text theo thứ tự `display_text → text → payload.display_text → payload.text → payload.content → payload.delta`; bỏ qua event **có** `reply_to_message_id` (đó là reply-nếu-một-cái, không phải câu trả lời của turn) `[I]`.

**Chốt một turn** `[I]`: `ack` của `/chat/stream` **không đáng tin** (best-effort). Đường tin cậy là **poll `/chat/history`** và coi turn hoàn tất khi text của `message.assistant` cuối **không đổi trong ≥2.0 s** (ngắn hơn sẽ cắt cụt turn dài). Trong khi text còn dài: poll 0.35 s; đã đứng: 0.6 s; có jitter. Fake-stream bằng cách cắt text đang dài ra theo miếng ~240 ký tự.

## 6. Model & khả năng

**Trên wire không có model selector.** App là agent **tự route**, tự xưng **Koda** (`czg86389 app.py:1566`). `protocol.json` có route `GET|POST /model` nhưng **không code nào gọi** `[I]`. Vì vậy:

| Model id công bố | Loại | Ghi chú |
|---|---|---|
| `muse-spark` | chat | id quen mắt nhất; alias chấp nhận: `muse-chat`, `koda`, `muse` |
| `muse-image` | image | thật chất là *một turn chat kèm chỉ dẫn sinh ảnh* |
| `muse-video` | video | như trên; có gate vùng/account |

Quy tắc: resolve theo **kind**, và **từ chối model sai kind bằng 400 rõ ràng** (học `www222fff/core/models.py:46-61`) — để `muse-video` không bao giờ được dùng làm chat. Không nhận `temperature`/`max_tokens`/`seed` (mẫu âm 0 hoặc bỏ qua và *nói rõ* trong capability flags).

**Tools:** không có function-calling native. `czg86389` tắt vì *trợ lý từ chối thẳng* in pseudo tool call (`config.py:114-120`). Hệ quả thật: **CLI agent không dùng Muse làm model code được.**Ta chỉ nhận `tools` cho khớp schema, rồi trả về một thông báo lỗi/diễn giải minh bạch thay vì âm thầm bỏ.

**Vision & input:** ảnh đi trong `items[]` dạng `{"type":"image","mime_type","data_base64","filename"}`; giới hạn của app: 10 file / 40 MiB mỗi file / 100 MiB tổng / video ≤120 s `[I]`.

**Quota không đo được:** `protocol.json` **không có route quota**; không header `X-RateLimit-*`. Chỉ còn: (a) phân loại **văn bản** câu trả lời (`out of credits`, `usage limit`, `limit reached`, `token limit`, `额度不足`, `积分不足`, `达到上限`) — và chỉ được tính khi câu trả lời **đã kết thúc**, vì đuôi trang chứa cả prompt và sidebar `[I]`; (b) ngày hết hạn của `hatch_vml`. Panel Settings→Usage chỉ cào được bằng DOM → ngoài phạm vi driver này.

## 7. Taxonomi lỗi → HTTP (nguyên tắc: không bao giờ trả 200 rỗng)

| Loại | Phát hiện | HTTP | cooldown account |
|---|---|---|---|
| `auth` | `/api/session` **401**; DOM có `log in/sign in/create an account` | 401 | vĩnh viễn tới khi re-import |
| `access` | `/api/session` **403** — *không phải* cookie hết hạn (có thể `hatch_vml` cũ / vùng / egress) | 403 | 600 s, **không** đổi trạng thái thành dead |
| `quota` | 429, hoặc văn bản quota ở câu đã kết thúc | 429 | ≥ 3600 s |
| `timeout` | mạng chậm, WS treo | 504 | **không phạt** — Muse chậm không nói gì về account |
| `upstream` | 5xx, frame lạ, `/api/session` status ≠ `assigned` | 502 | 120 s |
| `region` | từ chối video theo vùng (`country or region`, `not available for your account`) | 503 | cache chặn 6 h |
| `policy` | từ chối nội dung (`policy_violation`) | 400 | **không xoay account** — đổi account cũng bị từ chối |
| `exhausted` | mọi account đều cooldown | 503 + `Retry-After` | — |

## 8. Bảo mật & vận hành (bắt buộc trước khi bật)

- Bind **127.0.0.1 tuyệt đối**; `tunnelUrl` trong settings 9router **đang có giá trị trycloudflare** → phải kiểm tra `GET /api/tunnel/status` và ghi lại; nếu đang mở, **dừng** trước khi cho Muse vào router.
- Pool file ngoài git, mode `600`: `%APPDATA%/9router/muse/pool.json`; fixture **đã cắt credential**; log chỉ in `label`, không in cookie/token/`vm_id`.
- Sidecar có key riêng (`muse_local_…`), **không** dùng lại key 9router làm credential server.
- Cảnh báo ToS ghi thẳng trong `spec`: tự động hoá session web **có thể** bị rate limit / thu hồi session / khoá account; chỉ dùng cá nhân, tại local.

---

## Bo sung sau khi do live (2026-11-03, P1-P5) `[V]`

Cac dong duoi thay cho phan UNVERIFIED/INFERRED tuong ung:

1. **WS host**: `wss://hatch.metaaivm.com/v1/noise` (LB dung chung). Host-per-VM trong `endpoint_url` **tu choi upgrade** — no chi la `vmAddress` khi xin token.
2. **Noise**: msg1 = 66 B (`e` + `0a 20 <32B nonce>` sang rang), msg2 = 96 B + payload attestation (70 B voi VM thuong), msg3 = 64 B. **Khong** co 2-byte length prefix trong handshake. Nonce transport = 4 so 0 + u64 **big-endian**. `Split()` = HKDF(ck,"",2) => initiator (T1,T2), responder lay **nguoc lai**.
3. **MixHash chi doi `h`**, khong doi `ck`; payload rong van duoc hash; **mot** CipherState dung cho ca hai chieu trong bat tay => msg3 ma hoa o nonce 1. (Ba dieu nay duoc vector cong khai cua flynn/noise xac nhan byte-exact o hai chieu.)
4. **RPC**: `/api/ping` -> `{"ok":true,"server_ts_ms":...}`; `/model` -> `available_models` chi MOT phan tu `auto/auto`, `context_window_tokens=350000` => khong bo chon model duoc tren duong day.
5. **`/chat/history` khong phai NDJSON tung event**: mot object `{ok, result:{channel, chat_events[], has_more, transcript_revision}}`; event co `event_name`, `display_text` (snapshot lon dan), `display_text_ready`, `reply_to_message_id`, `seq`, `occurred_at_ms`, `payload`.
6. **Media**: artifact nam o `payload.data.images[]` voi `path=sandbox://workspace/...`, `variants.original=https://<vm>.metaaivm.com/media/raw/workspace/...`, `mime=image/webp`, `byte_len`, `width/height`, `label`. Duong lay bytes: `/media/raw/<path>` va `/fs/raw/<path>` **ca hai tra 200** qua tunnel (do duoc 16912 B webp). Quy chuan hoa path **giu lai** doan `workspace` theo dung URL cua gateway.
7. `nodes/register` + `register-capabilities`: **khong can** (hai turn chat va mot luot sinh anh chay ma khong goi).
8. Khong co route quota: `/api/limits` va `/capabilities` -> 404 `{"ok":false,"error":{"code":"not_found"}}`.
9. Khong co model selector: moi yeu cau `muse-chat`/`auto/auto` deu di vung cung mot agent tu xuong la Koda.
