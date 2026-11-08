# SDD — Thiết kế module

**Nguyên tắc:** một driver, hai cửa ra. `muse-bridge.cjs` là bộ não; `sidecar.cjs` và executor trong bundle chỉ là hai lớp vỏ gọi nó. Không sao chép logic giữa hai lớp vỏ.

## 1. Sơ đồ

```
CLI (Qoder/Claude Code) ─API key 9router─▶ :20129 9r-hedge-gateway        (đã chạy, không sửa)
                                            │
                                            ▼ :20128 9router
                       node "muse" (openai-compatible) ── bearer ──▶ :20141 muse/sidecar.cjs
                                                                     │  MuseBridge
                        (P5) muse-web executor wrapper ◀────────────┘  ├ lib/noise.cjs   Noise XX
                        globalThis.__9rMuseWrap(new y._5)              ├ lib/pb.cjs      protobuf wire
                            │  fallback                                 ├ lib/wire.cjs    frames/streams
                            ▼                                           ├ lib/session.cjs bootstrap+cookie
                                                        muse-web        ├ lib/history.cjs chốt turn
                                                        Playwright      ├ lib/approvals.cjs decide
                                                          (nguyên vẹn)  ├ lib/media.cjs  /media/raw
                                                                        └ lib/pool.cjs   nhiều account
                                                  ▼
                             wss://hatch.metaaivm.com/v1/noise   +   https://muse.ai/api/*
```

## 2. `lib/noise.cjs` — Noise_XX_25519_AESGCM_SHA256

Không dependency: `node:crypto` đủ. API khoá raw 32 byte là chỗ mọi người vấp, nên ghi sẵn:

```js
const X25519_PUB_DER_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // + 32 raw bytes
const x25519Public = (raw32) => crypto.createPublicKey(
  { key: Buffer.concat([X25519_PUB_DER_PREFIX, raw32]), format: "der", type: "spki" });
const dh = (privObj, pubObj) => crypto.diffieHellman({ privateKey: privObj, publicKey: pubObj }).getSharedSecret?.()
  ?? crypto.diffieHellman({ privateKey: privObj, publicKey: pubObj });   // Node 24 trả Buffer
```
- `crypto.generateKeyPairSync("x25519")` cho static key của client (VM thường không cần lưu static key giữa các phiên, nhưng Noise XX bắt buộc có `s` ở msg3 → sinh mỗi kết nối).
- HKDF-SHA256 `hkdf(salt, ikm, info="", L)` = `crypto.hkdfSync("sha256", ikm, salt, Buffer.alloc(0), L)`; **`L` của CipherState = 32**.
- `encryptWithAd(ad, plaintext)`: AES-256-GCM, IV = `Buffer.concat([Buffer.alloc(4), BE64(counter)])`, `authTagLength: 16`, tag **nối cuối** ciphertext. Counter **tăng sau mỗi lần dùng**, và mỗi chiều (`tx`,`rx`) có counter riêng sau `split()`.
- Handshake state giữ `h` (hash 32) và `cs` (chaining value 32): `mixHash` = `SHA-256(h || data)`; `mixKey` = HKDF(cs, ikm, 64) → `(cs, k)`.
- Xuất: `class NoiseXXInitiator { initialize(); writeMessage1(payload) /* e_pub(32)||AE(h)(payload) */; readMessage2(msg) /* ≥96B: e || enc(s)(es 32+tag) || enc(s)(payload+tag) */; writeMessage3(payload); split() → {tx, rx}; get handshakeHash() }`
- **Test được trước khi chạm mạng:** khớp `Noise_Pattern.txt` vector chính thức cho `Noise_XX_25519_AESGCM_SHA256` fallback pattern, và round-trip với server-side cùng thư viện trong `fake-gateway`.

## 3. `lib/pb.cjs` + `lib/wire.cjs`

`pb.cjs`: encode/decode tối thiểu — varint, tag = `field<<3 | wire`, wire 0 (varint), 2 (length-delimited), plus `readMessage(buf) → Map<field, value>`. Không reflection, không `.proto`.

`wire.cjs`: encoder/decoder đúng schema §4.3 `spec.md`, cùng:
```js
splitNoisePayload(buf, maxChunk = 48*1024) → NoiseTransportFrame[]   // chunk_id chia theo message đi
class NoiseReassembler { feed(frame) → buf|null }                     // inbound: KHÔNG giới hạn 48KiB
MAX_ASSEMBLY_BYTES = 16*1024*1024
```
**Bất đối xứng có chủ đích:** đi ra 48 KiB, đi vào chấp nhận chunk lớn tới 16 MiB — `spec.md` `[I]` nói gateway gửi message lớn thành *một* chunk, và chối chúng làm turn treo.

## 4. `lib/gateway.cjs` — stream multiplexing

```js
class HatchConnection {
  static async connect({ lbHost, wsPath, appId, vmId, authToken, notaryToken, signal, log })
  async request(verb, path, { body, service = "daemon", timeoutMs }) → { status, json }
  async *stream(verb, path, { body, service = "daemon" })             → JSON records
  async ack(verb, path, opts)   // request + đọc record đầu rồi Reset(code=1,"ack only")
  close(reason)
}
```
- `streamId` tăng dần theo chiều đi; map `streamId → {queue, done}`.
- **`Reset` bắt buộc** trên mỗi lối ra của `stream()` (`finally`), `reason` ∈ `"client aborted" | "client done" | "chat done" | "ack only"`; envelope Reset luôn pin `service=daemon` `[I]`.
- Send đi qua **một mutex** (`_sendLock`) và kiểm lại `_closed`/`_fatal` bên trong lock `[I]`.
- Mọi exception trong receive loop → đặt `_fatal`, đóng mọi stream chờ bằng `"connection closed"`.
- Frame giải mã lỗi: **log rồi bỏ qua**, không sập kết nối `[I]`.
- `AbortSignal` của caller nối thẳng vào `ws.close()` — R11 ("client ngắt thì đừng để job mồ côi").
- Retry upgrade: 4 lần, backoff `1.0 → ×1.5 → cap 3.0`, chỉ cho `502/503/504/"Refused WebSocket upgrade"` `[I]`.

## 5. `lib/session.cjs` — bootstrap & vòng đời cookie

```js
class HatchBootstrap {
  constructor({ jar, log })
  async renew({ vmState = "live" })          // GET /api/session?…; harvest Set-Cookie; trả meta
  async wake({ force = false })              // POST /api/hatch/vm/wake; KHÔNG đọc status để phán
  async waitRunning({ budgetMs = 45000, pollMs = 1500 })
  async tokens()                             // POST /api/hatch/token → {token, notaryToken}
  async open({ signal })                     // renew→(wake→waitRunning)→tokens→HatchConnection
}
```
- **`hatch_vml` là đồng hồ đếm ngược của account** (~48 h, không gia hạn bằng việc dùng): `pool.cjs` lưu `expires_at` từ cookie thật, **không** ảo gia hạn khi probe thành công `[I]` — bài học từ `store.py:58-73`.
- Ghi jar **atomic** (`write tmp → rename`), throttle 30 s, **buộc** sau `/api/session` `[I]`.
- 401 → `auth`; 403 → `access` (600 s) và **giữ nguyên** trạng thái đã biết, không ghi đè `[I]`.

## 6. `lib/history.cjs` — chốt một turn

`thread` mode mặc định (`spec §5` `[I]`: subscribe-delta **không** phủ reply của thread và race với việc tạo thread):
```
send POST /chat/stream (fire-and-forget sau ack best-effort)
→ poll GET /chat/history?limit=60&session_id=…
→ chọn message.assistant CUỐI có cùng/mới hơn ts_ms gửi, bỏ event có reply_to_message_id
→ TEXT_SETTLE_SECONDS = 2.0 (text đứng yên) → hoàn tất;  polling 0.35s khi còn dài, 0.6s khi đứng
→ trước khi return: approval_hold() kiểm /approvals còn treo không; nếu có và đã trả lời → reset settle, chờ tiếp
```
- Fake-stream: cắt đoạn mới bằng miếng 240 ký tự, **chỉ để khớp R2**, không phải để câu giờ.
- Deadline: first-token 75 s `[I]`, tổng 300 s; quá → `timeout` (không phạt account).

## 7. `lib/approvals.cjs` — R14

```js
class ApprovalPolicy { constructor(mode /* off|deny|allow_once|allow_session|allow_always */) }
async resolveAll(conn, { threadId, sessionId })   // GET /approvals → lọc đúng scope thread/session → decide
```
- **Mặc định `deny`.** Mỗi 3 s trong lúc chờ text. Chỉ đụng approval có `scope.thread_id`/`scope.session_scope_id` khớp turn hiện tại `[I]`.
- `deny` gửi `{"approval_id","decision":"deny"}`; `allow_always_scoped` phải gửi **cả** `always_scope` và `allow_always_scope` (daemon mới đọc key thứ hai) `[I]`.
- Không bao giờ tự đồng ý OAuth connector / `/api/consent/status` `[I]`.

## 8. `muse-bridge.cjs` — API ra ngoài (bên trong: pool + map OpenAI)

```js
class MuseBridge {
  constructor({ poolPath, pool, modelMap, timeouts, log, approvals, timezone })
  async models()                                        // → [{id, object:"model", owned_by:"muse"}] 3 cái
  async *chat({ model, messages, stream, signal, sessionKey, temperature })
      // yields {delta:string} | {done:true, text} ; throws typed MuseError
  async image({ prompt, n, size, aspectRatio, references, signal })   // → [{b64, mime}]
  async video({ prompt, duration, aspectRatio, firstFrame, signal })  // → [{b64, mime}]
  async testConnection()                                // → {ok, kind, account, vmState, expiresAt}
  healthz()                                             // {accounts:[{label,state,expiresInH,kind}], no secrets}
}
```
- **`wrap(executor)`** cho P5: `{ ...executor, execute: httpExecute, generateMedia: mediaOrDelegate }`; `httpExecute` bắt **mọi** exception → `await executor.execute(ctx)` (R8).
- Input OpenAI → `message`/`items`: system gom thành khối tiền tố, lịch sử nhãn `用户:/助手:` theo `www222fff`/`czg86389`, **một user turn duy nhất không system → gửi nguyên văn**; `content[]` image → `items[].image`; `tools` → **không im lặng**: trả `MuseError("unsupported","Muse wire has no function calling")` nếu client gửi tool *và* trông đợi chúng, còn nếu chỉ gửi kèm cho khớp schema thì bỏ có ghi log.
- Usage: `prompt_tokens:0, completion_tokens:0` + ghi rõ trong `spec` (N3).

## 9. `pool.cjs` — nhiều account

Trạng thái kế thừa máy trạng thái `www222fff` (`§7 spec`), vì nó là cái đáng tin nhất trong ba repo:
`active | cooling | invalid`; `AuthError→invalid` (mãi cho tới khi re-import), `QuotaError→cooling ≥3600 s`, **`Timeout→không đổi trạng thái`**, `access(403)→cooling 600 s`, `policy→không xoay`.
Chọn: `affinity` (mặc định, `sessionKey → account`, LRU-4096) → không có thì `lru` trên `(lastUsed, useCount)`; cap `maxConcurrency`/account = 2 `[I]`; failover **chỉ khi chưa emit ký tự nào** `[I]`; `video` ưu tiên account từng hoàn tất video `[I]`.
Pool file schema: `{version:1, accounts:[{id,label,cookies:{...},expiresAt,kind,state,useCount,lastUsed}]}`.

## 10. Seam trong bundle (P5)

- **Loader:** `9r-net-keeper.js` (đã được `--require` qua patch `cli.js`) thêm ~6 dòng: `if (process.env.NINEROUTER_MUSE_HTTP !== "0" && fs.existsSync(p)) try { globalThis.__9rMuseWrap = require(p).wrap } catch {}`. Lý do: `require` **không có trong scope** của webpack chunk factory `(a,b,c)`, nên bundle không tự nạp file được.
- **Needle:** `,"muse-web":new y._5` trong `chunks/5330.js` — **số lần xuất hiện đã đo = 1** → `,"muse-web":(globalThis.__9rMuseWrap?globalThis.__9rMuseWrap(new y._5):new y._5)`.
- **Descriptor:** `chunks/2598.js` `{id:"muse-web",…serviceKinds:["image","video"]}` → thêm `"llm"`, và thay `models:[{id:"muse-chat"}]` bằng ba id theo `spec §6`.
- **Media:** dispatcher trong `chunks/9128.js` gọi `executor.generateMedia({prompt,kind,size,model,duration,resolution,n,images,credentials,signal,log})` và **mong một mảng** `[{b64,mime}]` `[V]`; thiếu method → `[<provider>] has no executor video support`.
- **Chat contract:** `execute({model,body,stream,credentials,signal,log}) → {response:Response, url, headers, transformedBody}`; map lỗi của executor gốc `[V]`: `MuseWebAuthError:401, MuseWebQuotaError:429, MuseWebTimeoutError:504, MuseWebUpstreamError:502, AbortError:499`.
- Installer theo khuôn `patch-9r-*.js`: idempotent, `needle count !== 1 → ABORT`, backup `.pre-musehttp.bak`, `node --check` sau ghi, đăng ký vào `reinstall-9router-fixes.js`.

## 11. `fake-gateway.mjs` — vì sao test được mà không gọi mạng

Server Node **cài cùng một giao thức** (Noise XX + protobuf + các route §4.4) chạy trên `ws://127.0.0.1`. Driver và fake-gateway dùng **chung** `lib/noise.cjs`/`lib/wire.cjs`, nên round-trip tự chứng minh codec khớp… và chứng minh cả hai **cùng sai** nếu đọc spec lệch. Ba hàng phòng vệ:
1. Vector Noise chính thức (`Noise_Pattern.txt`) — neo thuật toán crypto, không phụ thuộc repo nào.
2. Golden bytes cho từng frame, ghi từ fixture capture thật (`fixtures/*.json`) khi có.
3. `test-muse-live.js` (gated `MUSE_LIVE=1`) đối chiếu fake-gateway với hành vi thật trên **đúng** các ca đã fixture.

---

## Thuc te da dung (doi chieu voi thiet ke o tren)

| Thiet ke | Thuc te | Ly do |
|---|---|---|
| `lib/history.cjs` (muc 6) | nam trong `muse-bridge.cjs`: `_history()`, `pickAssistant()`, `textOf()` tach ra test duoc | chot turn va parse text chung mot voi `delta.*`, tach file chi them bo trung gian |
| `lib/approvals.cjs` (muc 7, R14) | `muse-bridge.cjs`: `_pendingApprovals/_decideApproval/_sweepApprovals`, sentinel service, `MUSE_APPROVALS=deny\|allow_once\|allow_always\|off` | approval chua tra loi lam turn treo den het budget (§C6), nen no thuoc vong lap turn |
| `fake-gateway.mjs` server WS `127.0.0.1:20142` (muc 11) | `fake-tunnel.cjs` **in-process**, khong socket | test all deterministic, khong tranh port, khong AI; duong WS that da co gate C2 live chung minh |
| `lib/media.cjs` (muc 8-9) | dung nhu thiet ke + `tunnelPathFromUrl()` | URL cua chinh gateway la candidate tin cay nhat; `normalizeGatewayPath` **giu** doan `workspace` |
| Seam `open-sse/lib` + `require` trong chunk | keeper dat `globalThis.__9rMuseWrap`, bundle dung ternary thuan | chunk factory khong co `require` trong scope |
| `test-muse-live.js` | `probe-live.mjs` + `probe-routes.mjs` + `probe-media.mjs` + `parallel-muse.js` (che do `MUSE_LIVE=1`) | tam goc do hon la mot file gop |

Ba sai lech ma vector + gateway that da sua so voi thiet ke ban dau:
1. `Split()` khong phai (T2,T3) ma (T1,T2), va **phía responder lay nguoc lai** — neu khong thi ca hai phung cung encrypt mot khoa.
2. `MixHash` khong doi `ck`; payload rong van duoc hash; **mot** CipherState dung chung hai chieu trong bat tay.
3. Muse khong dung 2-byte length prefix trong handshake (khac vector goc), va nonce transport la **big-endian**.
