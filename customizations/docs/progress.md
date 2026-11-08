# Progress — nhật ký bằng chứng

Quy tắc: **một claim = một dòng + một lệnh tái hiện được**. Không có claim "đã xong" mà không có số liệu.
Nhãn độ tin: `[V]` đo từ account của anh · `[I]` từ mã nguồn `its-benjamin/muse2api-http` · `[H]` heuristic.

## Trạng thái pha

| Pha | Kết quả | Ghi chú |
|---|---|---|
| P0 bộ tài liệu | **xong** | 8/8 file trong `muse/` |
| P1 Noise + wire | **xong** | `lib/noise.cjs` `lib/pb.cjs` `lib/wire.cjs` `lib/gateway.cjs` `fake-tunnel.cjs`; 6+6+12 case offline xanh, và gate C2 live đạt (M6) |
| P2 một turn chat live | **xong** | bridge 13 case xanh; hai turn thật qua key 9router trong ~12 s (M7, M8) |
| P3 sidecar + node 9router | **xong** | node `mweb` + connection, **không restart** (M8); telemetry `requestDetails` có dòng (M9) |
| P4 image/video | **driver xong + đã đo live** | `lib/media.cjs` + `bridge.generate/image/video`; tai anh that qua tunnel = 16912 B `image/webp` (M10). Full-circuit `POST /v1/images/generations` sau khi sua path van chua chay (can 1 luot sinh moi). Video: chua do — co the bi tu choi theo vung. |
| P5 in-bundle | **xong** | `--apply` da chay, 9router da restart 3 lan; `muse-web/muse-chat` tra lời truc tiep 10,2 s **khong can sidecar** (M11). Rollback: `--revert`. |

### M10 — Media live: artifact va duong tai qua tunnel `[V]`
`MUSE_LIVE=1 node muse/probe-media.mjs "A tiny red circle on a white background, flat vector"` (doc lai turn da sinh, 0 quota):
```
delta.presentation kind=image refs=1
  node keys: byte_len,height,label,mime,missing,path,variants,width
  path=sandbox://workspace/imagine_media/media-generation-tiny-red-circle-0-…webp  mime=image/webp  byte_len=16912  1600px
  /media/raw/workspace/imagine_media/… -> 200 bytes=16912 ct=image/webp
  /fs/raw/workspace/imagine_media/…   -> 200 bytes=16912 ct=image/webp
```
Sua loi: `normalizeGatewayPath` tung cat doan `workspace` (theo `minh`) ⇒ hai route 404 roi roi sang HTTPS (VM URL khong public) → `fetch failed`. Nay giu `workspace/` nhu chinh URL cua gateway, va thu `variants.original` truoc.

### M11 — P5 in-bundle `[V]`
```
curl :20128/v1/chat/completions -d '{"model":"muse-web/muse-chat", ...}'  -> 10,2 s, "IN-BUNDLE-MUSE-OK"
```
Driver chay trong bundle 9router (keeper → `globalThis.__9rMuseWrap` → registry ternary), credential lay tu connection `muse-web` cua chinh 9router. Phat hien di kem: Playwright executor **hong san** voi cookie nay — `browserContext.addCookies: Invalid cookie fields` (cookie `__Host-`), nen duong fallback cua muse-web media khong con duoi. Duong truc tiep la duong duy nhat con chay.

## Bảng kiểm offline (chạy lại được, không mạng, không credential)
```
node muse/test-noise.js     all 6 noise cases passed
node muse/test-wire.js      all 6 wire cases passed
node muse/test-gateway.js   all 12 gateway cases passed
node muse/test-bridge.js    all 13 bridge cases passed
node muse/test-media.js     all 7 media cases passed
node muse/test-executor.js  all 10 executor cases passed
```

## Bằng chứng đã có

### M1 — Muse chấp nhận Node client ở tầng bootstrap `[V]`
Lệnh: `node muse/probe-session.mjs`
```
{"transport":"undici fetch (h1)","ms":917,"status":200,"session_status":"assigned","vm_state":"SUSPENDED",
 "fields":"status,vm_selection,vm_id,endpoint_url,vm_name,vm_state,vm_type,replaced_vm_id,migration_state,replace_attempt_id,vm_state_source,vms",
 "rotated":"hatch_sess,hatch_sess,hatch_vml,hatch_vml"}
{"transport":"node:http2 (h1 TLS profile)","ms":627,"status":200,"session_status":"assigned", … ,
 "rotated":"hatch_sess,hatch_vml"}
```
Ý nghĩa: **phủ quyết** claim "Meta edge proxy reject stock TLS fingerprints" (áp cho `/api/session`). Không cần `curl_cffi`/Python. Đồng thời **xác nhận** cookie bị xoay khi dùng → pool phải ghi ngược.

### M2 — Wake hoạt động, VM thường, đạt RUNNING trong 2.1 s `[V]`
Lệnh: `node muse/probe-wake.mjs`
```
bootstrap: session=assigned vm_state=SUSPENDED vm_type=hatch_vm gateway=metaaivm.com
2. wake            http=200 body={"status":"wake_requested"}
   poll            +2.1s http=200 vm_state=RUNNING gateway=metaaivm.com
4. /api/hatch/token http=200 fields=token,notary_token rotated=[hatch_gw]
5. notary token     http=200 fields=notaryToken
```
Ý nghĩa: (a) `vm_type=hatch_vm` → **không** phải Confidential VM, bỏ được cả nhánh `MUSE_CVM_RV_KEY`/notarised msg3 — rủi ro lớn nhất của plan; (b) `/api/hatch/token` trả **luôn** `notary_token`, đơn giản hơn hai-call flow của repo; (c) `hatch_gw` do chính token endpoint cấp.

### M3 — Không có surface HTTP trên gateway; WS mở được từ Node `[V]`
Lệnh: `node muse/probe-gateway.mjs`
```
A. http GET /health auth=none -> ERR fetch failed      (và auth=bearer, /api/ping: như vậy)
B. wss <uuid>.metaaivm.com -> CLOSED code=1002 "non-101 status" after 82ms
B. wss hatch.metaaivm.com   -> OPEN (101) in 923ms  protocol="-"
   stayed open 3s, first frame: (none, as expected for initiator-first XX)
```
Ý nghĩa: `endpoint_url` là host **nội bộ** (chỉ dùng làm `vmAddress` khi xin token), LB công khai là `hatch.metaaivm.com`. Đường tắt "dùng REST cho nhẹ" **không tồn tại** → Noise-XX là bắt buộc, và Node tới được cửa đó.

### M4 — Hiện trạng 9router `[V]`
- `muse-web` provider descriptor: `serviceKinds:["image","video"]` → chat **không** được UI/router coi là llm (`chunks/2598.js`).
- Chưa từng có dòng muse nào trong `usageHistory` (0) và `requestDetails` (0/1000) → không có hành vi chat cũ để phá.
- Credential đã lưu: connection `be54be5f…`, `testStatus:"active"`, 1523 ký tự, mở đầu `__Host-hatch_one_tap=`.
- Seam P5 unique: needle `,"muse-web":new y._5` trong `chunks/5330.js` xuất hiện **1** lần.
- Node 24.18.0: `WebSocket` và `fetch` là global; `EventSource` **không** → tự parse SSE.

### M5 — Các repo tham chiếu `[I]`
| repo | cho gì | **không** cho gì |
|---|---|---|
| `czg86389-hub/muse2api` (anh chọn, v1.6.7, 2026-11-03) | vòng đời cookie (`hatch_vml` 48 h), taxonomi lỗi, selector DOM, discrimination ảnh/video, anti-refetch ảnh upload, pool sticky-15 | **không có** protocol: 0 chuỗi `wss://`, chỉ 2 endpoint muse.ai (giống hệt 9router) |
| `www222fff/muse2api` | máy trạng thái account pool đáng tin nhất, ánh xạ OpenAI + `/v1/responses`, số đo concurrency thật | `HttpDriver.chat_stream` = **raise 501**, TODO B1 "Not started" |
| `its-benjamin/muse2api-http` | **transport thật**: Noise XX, protobuf, `protocol.json` 352 route, `chat/stream`+`chat/history`+`media/raw`+`approvals`, cookie-rotation persistence, cooldown ladder | chưa chạy lại trên account của anh; một chi tiết tự mâu thuẫn (comment "48 KiB" vs constant 4 MiB) |

### M6 — Gate C2: tunnel Noise thật mở được từ Node và RPC trả JSON `[V]`
Lệnh: `MUSE_LIVE=1 node muse/probe-live.mjs`
```
account=9r:be54be5f  vm ready state=RUNNING type=hatch_vm woke=false waitMs=0
token issued auth=true notary=true
tunnel: noise connected {serverStatic:"672221243115805b", attestationBytes:70}
+2.67s noise handshake OK on attempt 1 (variant=muse)
+0.25s POST /api/ping  -> 200 bytes=40 body={"ok":true,"server_ts_ms":…}
+0.23s GET  /model     -> 200 bytes=302 body={"ok":true,"result":{"selected_model":"auto/auto",…
GET /api/session/list  -> 200 bytes=468
```
Ý nghĩa: toàn bộ chuỗi Noise-XX (profile `muse`) + protobuf framing + `ServiceRequest/ServiceFrame/ApplicationRequest` **được gateway chấp nhận nguyên vẹn** — không cần browser, không cần Python. `variant=muse` thắng ngay lần đầu ⇒ các quy ước đã ghi trong `protocol-notes.md §A` là đúng với server thật.

### M7 — Hai sửa đổi bắt buộc so với tài liệu cũ `[V]`
1. **Host**: `wss://<vm_id>.metaaivm.com/v1/noise` báo lỗi socket; `wss://hatch.metaaivm.com/v1/noise` (LB) mới mở được ⇒ `session.wsUrl()` mặc định LB host, không dùng `endpoint_url` làm host (chỉ dùng nó làm `vmAddress` khi xin token).
2. **Noise profile**: `MixHash` chỉ đổi `h`, không đổi `ck`; payload rỗng vẫn được hash; **một** CipherState dùng chung cho hai chiều trong bắt tay (⇒ msg3 mã hoá ở nonce 1, không phải 0); `Split()` = HKDF 2 output, initiator lấy T1/T2, **responder lấy ngược lại**. Cả bốn đều được kiểm chứng bằng vector công khai (`test-noise.js` N1/N2 byte-exact, hai chiều).

### M8 — Một request OpenAI đi hết đường, dùng chính key của 9router, không restart `[V]`
Lệnh: `curl -X POST :20128/v1/chat/completions -H "Authorization: Bearer <9router key>" -d '{"model":"mweb/muse-chat", …}'`
```
non-stream 12.5s → {"model":"muse-chat","choices":[{"message":{"content":"MUSE-OK-FROM-9ROUTER"},"finish_reason":"stop"}]}
stream     12.1s → 5 frame SSE: role / content / finish_reason stop / [DONE]
```
Bài học đăng ký: `prefix:"muse"` **bị provider dựng sẵn `muse` (api.meta.ai) giành mất** → router báo `No active credentials for provider: muse`. Prefix phải không trùng: đã đổi sang `mweb` và xoá node cũ sạch. `POST /api/provider-nodes` chỉ tạo node; phải gọi tiếp `POST /api/providers {provider:<nodeId>, apiKey, providerSpecificData.baseUrl}` để tạo connection.

### M9 — Telemetry 9router nguyên vẹn (R8/R9) `[V]`
```
requestDetails: provider=openai-compatible-chat-b470f9c3…, model=muse-chat, connectionId=19e75a16…, status … (2 dòng = 2 lượt gọi)
usageHistory:   count(model like '%muse-chat%') = 1
```

## Câu hỏi còn mở

| # | Câu hỏi | Cách trả lời |
|---|---|---|
| Q1 | msg2 payload của VM thường có thật sự chỉ là attestation blob bỏ qua được không? | **ĐÃ TRẢ LỜI `[V]`**: 70 byte, client không cần hiểu; handshake vẫn thành công và ping 200. |
| Q2 | Một `/chat/stream` có bắt buộc `/api/nodes/register` + `register-capabilities` trước không? | **ĐÃ TRẢ LỜI `[V]`**: không bắt buộc — hai turn thật chạy mà không gọi route nào trong số đó. |
| Q3 | Tài khoản của anh có được phép sinh video không? (repo czg86389 có issue #23 đúng chuyện này) | P4, một lần, có phép anh |
| Q4 | Có cách nào đọc quota mà không cào DOM Settings? | vẫn **không** — `/api/limits` và `/capabilities` trả 404 `route not found` `[V]` |
| Q5 | Custom provider node trong 9router có khai báo media được không (imageConfig)? | P4/P5 — node POST chỉ nhận name/prefix/apiType/baseUrl/type ⇒ media không khai báo qua API này |
| Q6 | `/model` cho gì? | **ĐÃ TRẢ LỜI `[V]`**: đúng một model `auto/auto`, `context_window_tokens=350000`, `display_name:"Auto"` ⇒ không có bộ chọn model trên đường truyền; alias `muse-chat` là tên cục bộ. |
| Q7 | Streaming có thật sự "từng token" không? | hiện tăng theo nhịp poll 1,2 s (snapshot `display_text`). Muốn mượt hơn phải dùng `/chat/subscribe` + sự kiện `delta.text_append` — chưa làm. |

## Cờ an toàn (mục C1 của check-list) `[V]`

`GET :20128/api/tunnel/status` lúc 16:38:
```
tunnel.enabled=true running=true
tunnelUrl=https://surveillance-separation-skiing-bolt.trycloudflare.com
publicUrl=https://rr6g38g.abc-tunnel.us
```
⇒ 9router **đang công khai trên internet**. Sidecar bind `127.0.0.1` và có bearer key riêng (`%APPDATA%/9router/muse/sidecar.key`, 0600) nên Muse không mở thêm cửa nào mới; nhưng mọi thứ đi qua router (kể cả `mweb/*`) đều tới được từ hai URL kia bằng key 9router. Quyệt định là của anh: tắt tunnel, đổi key, hoặc giữ.

## Việc kế tiếp (đúng thứ tự)

1. **P4 media**: đọc `protocol-notes.md §D`, thử `/media/raw` + `/fs/raw` qua tunnel thật, rồi `bridge.image()/bridge.video()` + T11–T14. Sidecar đang trả 501 cho `/v1/images/generations` và `/v1/videos` (có chủ đích, không giả API).
2. **Test song song** (nhiệm vụ 7 của plan): 6 turn đồng thời qua `:20129`, đo head-of-line — kỳ vọng thấp vì một account một VM.
3. **P5 in-bundle**: `patch-9r-muse-executor.js` + needle `,"muse-web":new y._5` (đếm = 1), driver ở `%APPDATA%/9router/runtime/muse-web-http-executor.cjs`, keeper đặt `globalThis.__9rMuseWrap`, fallback Playwright giữ nguyên. Restart: anh đã nói không còn ảnh hưởng, nhưng vẫn xin phép trước khi bấm.
4. Cập nhật `spec.md §Protocol` từ `[I]` sang `[V]` cho các dòng M6–M9 đã đổi (LB host, nonce, split, `Split()` phía responder).
5. Dọn fixture: `fixtures/vectors.txt` + `cacophony.txt` (2,8 MB) nên xoá sau khi `noise-vectors.json` đã chốt; giữ `build-vectors.cjs` để tái tạo.

### M12 — `POST /v1/images/generations` qua 9router, in-bundle `[V]`
```
curl -X POST :20128/v1/images/generations -d '{"model":"muse-web/muse-image","prompt":"A small blue square…","n":1}'
  -> http=200 36.1 s, data[0] = {b64_json, mime_type}, decode = 15334 B, magic 52494646…57454250 = RIFF/WEBP
```
Đây chính là hợp đồng E15 (`generateMedia` trả `[{b64, mime}]`), 9router tự đổi thành `b64_json`/`mime_type`. R10 ĐẠT end-to-end, không Chromium.

### M13 — Nhịp stream `[V]`
`pollIntervalMs` 1200 ms khi chờ, `fastPollMs` 350 ms khi câu trả lời đang lớn dần; kết thúc = snapshot đứng yên `quietMs` (2 s, đúng `TEXT_SETTLE_SECONDS` của client tham chiếu, vì thread mode không có cờ hoàn tất).

### Hệ quả kiến trúc
`muse-web` (in-bundle) **không cần sidecar**; node `mweb` thì cần tiến trình `muse/sidecar.cjs` sống. Việc autostart vẫn là quyết định của anh (Run key / Startup), chưa tự thêm.

### M14 — Dang ky test offline lan cuoi `[V]`
61 case xanh: noise 6, wire 6, gateway 12, bridge 15 (gom B14/B15 approval), media 7, executor 11, sidecar 5. `parallel-muse.js` offline 8/8 ~98 ms.

### M15 — Video live, in-bundle `[V]`
`POST :20128/v1/videos/generations {model:muse-web/muse-video, prompt:a 3 second loop…, duration:3}`
```
http=200  1m51.7s  {id, object:video.generation, status:completed, video.url}
video.url = data:video/mp4;base64,…  -> muse-video.mp4  725032 B  magic ftyp (isom/avc1)
```
Trả lời Q3: tài khoản này **không** bị gate video (khác issue #23 của czg86389). Route đúng là `/v1/videos/generations`, không phải `/v1/videos` (route đó 404 HTML).

### M16 — 6 turn đồng thời, tài khoản thật `[V]`
`MUSE_LIVE=1 node muse/parallel-router.mjs 6` (model muse-web/muse-chat, qua :20128):
```
wall 24.0 s | per-turn 10.2 / 13.6 / 15.0 / 16.7 / 16.7 / 24.0 s | requestDetails: 6 dong success
```
So với 1 turn ~11 s: 6 turn chỉ lâu hơn ~2 lần, **không** phải 6 lần ⇒ tầng của mình không serialize; contention duy nhất là VM của Muse.
Lưu ý measurement: executor trả **SSE** cả khi không xin `stream:true`, nên script phải đọc được `data:` frames (đã sửa trong `parallel-router.mjs`; lần chạy đầu parse sai nên in ra `0 chars` dù 6 turn đều success).

### Chốt kiến trúc (quyết định của anh 2026-11-03)
`mweb` provider node + connection **đã xoá qua API**, sidecar đã dừng. Đường duy nhất còn lại là `muse-web/*` trong bundle 9router — không tiến trình phụ, không autostart. `muse/sidecar.cjs` + `test-sidecar.js` vẫn nằm trong repo như phương án tuỳ chọn (5 case vẫn xanh) và có thể bật lại bằng cách đăng ký node theo `harness.md`.

### M17 — Vì sao `muse-web/muse-chat` không thêm vào client được `[V]`
Gọi thẳng API thì chạy, nhưng `GET /v1/models` **không liệt kê** nó ⇒ mọi client chọn model từ danh sách sẽ báo không có.
Nguyên nhân đo được: descriptor `muse-web` tồn tại ở **5 bản sao** trong bundle, tôi mới vá 1:
```
server/chunks/2598.js   serviceKinds:[image,video,llm]  <- bản đã vá (routing)
server/chunks/4480.js   serviceKinds:[image,video]       <- catalog
server/chunks/8499.js   serviceKinds:[image,video]       <- catalog
static/chunks/1321-*.js serviceKinds:[image,video]       <- dashboard picker (client bundle)
```
Installer giờ tự đi tìm mọi file chứa needle và vá từng file (mỗi file backup + `node --check`), `--revert` cũng phục hồi hết. Sau khi vá + restart: `/v1/models` trả `"id":"muse-web/muse-chat"`.
Lưu ý phía trình duyệt: chunk tĩnh đã đổi nội dung nhưng **giữ nguyên tên file hash**, nên dashboard phải hard refresh (Ctrl+F5) mới thấy.

### M18 — Tool calling: 9router quảng cáo sai, mình sửa hành vi `[V]`
`/v1/models` mô tả `muse-chat` với `capabilities.tools:true`, nhưng Muse **không** có tool calling trên đường dây. Client nào luôn gửi `tools` (rất phổ biến) sẽ dính đường Playwright đã hỏng.
Hành vi mới: `tools` bị **loại bỏ và trả lời bình thường** (frame hoàn tất có `toolsStripped:true`); chỉ báo 400 `policy` khi client ra `tool_choice:"required"`. Kiểm chứng offline: B6 (bridge) + X5 (executor).