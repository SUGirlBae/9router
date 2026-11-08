# Harness — cách chạy mọi thứ

## 0. Port & đường dẫn

| thứ | chỗ |
|---|---|
| 9router dashboard + API | `http://127.0.0.1:20128` |
| Hedge gateway (đã chạy, không sửa) | `http://127.0.0.1:20129` → `/healthz` |
| Muse sidecar (mới) | `http://127.0.0.1:20141` → `/v1/models`, `/v1/chat/completions`, `/healthz` |
| Fake gateway để test | `ws://127.0.0.1:20142` (chỉ trong test, không bao giờ bind ngoài loopback) |
| DB 9router (chỉ đọc) | `%APPDATA%/9router/db/data.sqlite` |
| Pool Muse (driver tự tạo) | `%APPDATA%/9router/muse/pool.json` (mode 600, ngoài git) |
| Driver cho P5 | `%APPDATA%/9router/runtime/muse-web-http-executor.cjs` |
| better-sqlite3 để script đọc DB | `C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3` |

## 1. Env vars

| biến | mặc định | ý nghĩa |
|---|---|---|
| `MUSE_POOL` | `%APPDATA%/9router/muse/pool.json` | file account |
| `MUSE_SIDECAR_PORT` | `20141` | |
| `MUSE_SIDECAR_KEY` | *bắt buộc set* | bearer của sidecar; không đặt → sidecar **từ chối start** (không tự sinh key âm thầm rồi lộ) |
| `MUSE_LB_HOST` / `MUSE_WS_PATH` / `MUSE_APP_ID` | `hatch.metaaivm.com` / `/v1/noise` / `hatch-web` | ba hằng số wire |
| `MUSE_CHAT_TIMEOUT_MS` / `MUSE_FIRST_TOKEN_MS` | `300000` / `75000` | |
| `MUSE_IMAGE_TIMEOUT_MS` / `MUSE_VIDEO_TIMEOUT_MS` | `240000` / `600000` | |
| `MUSE_APPROVALS` | `deny` | `off\|deny\|allow_once\|allow_session\|allow_always` |
| `MUSE_TIMEZONE` | `UTC` | gửi trong body turn |
| `MUSE_LIVE` | *unset* | **chỉ live test**; có = 1 mới gọi muse.ai |
| `NINEROUTER_MUSE_HTTP` | `1` | `0` → P5 wrapper trả thẳng Playwright |
| `NINE_R_DB` | DB thật | test trỏ tới sqlite fixture |

Windows/Git Bash: đường dẫn inject vào source JS phải **forward-slash** (`\r` trong `C:\Users\…\runtime` sẽ bị parse thành carriage return — đã trả giá một lần với net-keeper).

## 2. Chạy offline (không đụng account)

```bash
cd "C:/Users/Administrator/Documents/Qoder/2026-11-03/10707d32"
node muse/test-noise.js && node muse/test-wire.js && node muse/test-session.js
node muse/test-history.js && node muse/test-pool.js && node muse/test-media.js
node muse/test-muse-bridge.js && node muse/test-sidecar.js
```
Fake gateway (`muse/fake-gateway.mjs`) dùng **chung** `lib/noise.cjs` + `lib/wire.cjs` với driver, và replay fixture ở `muse/fixtures/`. Muốn nó giống thật hơn nữa: `MUSE_FAKE_LATENCY_MS=800` để kiểm giờ, `MUSE_FAKE_ASK_APPROVAL=1` để kiểm R14, `MUSE_FAKE_QUOTA=acc2` để kiểm cooldown.

## 3. Probe live (chi phí 0, có tác dụng phụ nhỏ)

```bash
node muse/probe-session.mjs    # 2 GET /api/session (undici h1 + node:http2) — chỉ đọc
node muse/probe-wake.mjs       # renew → wake → poll RUNNING → mint token (KHÔNG gửi tin nhắn)
node muse/probe-gateway.mjs    # bootstrap + thử surface HTTP trên gateway + thử WS upgrade (0 byte)
```
Ba script này **đã chạy và ghi kết quả trong `progress.md`**. Tác dụng phụ duy nhất: **đánh thức VM** của account (chính là điều nút "test connection" của 9router vẫn làm — module 20690 post `/api/hatch/vm/wake`). Không tốn quota tin nhắn. Không in credential/`vm_id`/token.

## 4. Capture protocol thật (P1, nếu wire `[I]` lệch)

1. `muse/capture-muse.mjs` + browser-use connector: điều khiển tab muse.ai **đã đăng nhập** của anh, gửi đúng **một** tin nhắn 3 từ, rồi `list_network_requests` (gồm cả WebSocket frame) → `muse/fixtures/capture-<date>.json`, **đã cắt cookie/token** trước khi ghi đĩa.
2. Đây chính là kỹ thuật đã dùng thành công cho DeepSeek/Qwen: `../capture-ds-browser.js`, `../ds-browser-capture.json`, `../login-capture-qwen.js`.
3. Ưu tiên: nếu `POST /api/ping` qua tunnel trả JSON hợp lệ, nghĩa là Noise + framing đã đúng → **không** cần capture. Capture chỉ để soi `delta.presentation` (media) và các field text thật.

## 5. Chạy sidecar + đăng ký vào 9router (P3 — không restart)

```bash
# 1) start
MUSE_SIDECAR_KEY=$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
node --require ./9r-net-keeper.js muse/sidecar.cjs > muse/sidecar.log 2>&1 &
curl -s http://127.0.0.1:20141/healthz | head -c 400

# 2) đăng ký node (API đã kiểm chứng shape trong app/api/provider-nodes/route.js)
curl -s -X POST http://127.0.0.1:20128/api/provider-nodes \
  -H "Content-Type: application/json" -H "Authorization: Bearer <dashboard-session>" \
  -d '{"name":"Muse Bridge","prefix":"muse","apiType":"chat","baseUrl":"http://127.0.0.1:20141/v1","type":"openai-compatible"}'
```
- `apiType` được validate bởi một guard nhập từ chunk (`"Invalid OpenAI compatible API type"`) → liệt kê thực nghiệm, dự kiến `chat|responses`.
- Nếu bị `"URL not allowed"` (guard `PA(baseUrl)` trong `provider-nodes/validate/route.js`): **không tắt guard**; đăng ký qua dashboard UI và ghi lý do vào `sdd.md`.
- Địa chỉ model sau khi đăng ký theo tiền lệ node `9RouterWom` → `muse/<id>` (E19).

## 6. Kiểm chứng bằng chính API key của 9router (R1)

```bash
node gw-test.js muse/muse-spark 6      # harness sẵn có, 6 turn song song qua :20129
node muse/gw-check.js muse/muse-spark "Trả lời đúng một từ: MUSE-OK"
node muse/parallel-muse.js 6           # P7: bao nhiêu luồng cùng lúc, có head-of-line không
```
Bằng chứng telemetry (R9):
```bash
node -e "const D=require('C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3');
const db=new D('C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite',{readonly:true});
console.log(db.prepare(\"select provider,model,status,count(*) n from requestDetails where provider like '%muse%' group by 1,2,3\").all());"
```

## 7. P5 (in-bundle) — thủ tục restart

```bash
node muse/patch-9r-muse-executor.js --dry-run     # in plan, KHÔNG ghi
node muse/patch-9r-muse-executor.js               # apply + backup + node --check
# >>> DỪNG: báo anh là cần restart và để anh quyết <<<
# chỉ sau khi anh đồng ý:
node 9r-status.js                                  # trạng thái trước
# restart theo cách anh chọn (dashboard có /api/version/shutdown; hoặc taskkill theo PID)
node muse/probe-session.mjs                        # router sống lại chưa
curl -s http://127.0.0.1:20129/healthz | head -c 200
```
Rollback P5: khôi phục `chunks/5330.js`/`chunks/2598.js` từ `.pre-musehttp.bak`, xoá driver trong `runtime/`, bỏ entry khỏi `reinstall-9router-fixes.js`, rồi restart (lại cần anh duyệt).

## 8. Đọc log

- Sidecar: `muse/sidecar.log` — mỗi dòng `[muse] turn=<id> acc=<label> ttfb=…ms total=…ms kind=…`; **không** có cookie/token/`vm_id` (test Y3 quét regex credential để bắt nếu ai đó thêm log).
- Gateway: `/healthz` của 9r-hedge-gateway cho `byModel`, `circuits`, và giờ thêm lane `muse/*` nếu bật pin.
- 9router: `usage/request-details` (rolling 1000 dòng) và `%APPDATA%/9router/logs`.

## 9. Vệ sinh

```bash
node muse/doctor.js        # port bận? pool hết hạn? driver load được? tunnel đang bật?
node muse/cleanup.js       # tắt sidecar, huỷ node đăng ký, KHÔNG đụng bundle
```
`doctor.js` in **tài khoản nào sắp hết hạn `hatch_vml` (< 12 h)** — đây là lý do số 1 khiến provider "đùng một cái" chết.

---

## Bo sung sau khi do live (2026-11-03, P1-P5) `[V]`

### Thu that da dung (thay cho mo ta cu)

```bash
# 1) offline, khong mang
for f in noise wire gateway bridge media executor; do node muse/test-$f.js; done   # 55 case

# 2) do that, an toan (khong ton quota)
MUSE_LIVE=1 node muse/probe-live.mjs        # ping + /model + session/list
MUSE_LIVE=1 node muse/probe-routes.mjs      # do hinh dang route
MUSE_LIVE=1 node muse/probe-media.mjs "<prompt da sinh>"   # tai lai anh qua tunnel, 0 quota
```

### Dang ky 9router (hai buoc, khong restart)
`POST /api/provider-nodes` chi tao NODE. Muon router thuc su routing phai goi tiep
`POST /api/providers` voi `provider = <nodeId>`, `apiKey` (key cua sidecar) va
`providerSpecificData.baseUrl`. Sau do `GET /v1/models` lien liet ke `mweb/muse-chat` — **khong can restart**.

**prefix `muse` da bi tu choi**: trung ten provider `muse` (api.meta.ai) co san, router tra
`No active credentials for provider: muse`. Prefix phai khong trung provider dung.

### Khoi dong lai 9router (da dung 3 lan)
```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match '9router' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
powershell -NoProfile -Command "Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\9router\cli.js','--skip-update','--no-browser' -WorkingDirectory 'C:\Users\Administrator' -WindowStyle Hidden"
```
`restart-9router.ps1` (goi `/api/shutdown` + vong lap health) **tre** khong in ket qua; cach tren xong ~7 s.

### Bien moi
- `NINEROUTER_MUSE_HTTP=0` + restart: tat duong truc tiep trong bundle, muse-web quay ve Playwright.
- `MUSE_HOME` / `MUSE_RUNTIME`: do keeper dat; dung khi test wrapper ngoai bundle.
- `MUSE_NOISE_VARIANT=muse|prefixed|splitcipher` (probe-live): nghi dung khi bat tay that bai.

### Sidecar co that can?
- `muse-web/*` (in-bundle): khong can tien trình nao khac 9router.
- `mweb/*` (provider node): **can** `node muse/sidecar.cjs` song; kiem tra `curl :20141/healthz`.
- Muon tu tao autostart: tao shortcut trong Startup hoac `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` — day la thay doi cap may, anh quyet.

### Duong that hien tai (khong con sidecar)
```
client -> :20128 /v1/chat/completions  model=muse-web/muse-chat
       -> :20128 /v1/images/generations model=muse-web/muse-image
       -> :20128 /v1/videos/generations  model=muse-web/muse-video
```
Khong can tien trinh phu. Muon do lai song song: `MUSE_LIVE=1 node muse/parallel-router.mjs 6` (ton 6 tin nhan that).

### Model picker khong hien `muse-web/muse-chat`
Do descriptor nam o 5 cho trong bundle. Cai bang:
```bash
node muse/patch-9r-muse-executor.js --apply   # va het moi ban, co dry-run phia truoc
```
roi restart 9router va hard refresh dashboard. Kiem tra: `curl -H "Authorization: Bearer <key>" :20128/v1/models | grep muse-web`.
