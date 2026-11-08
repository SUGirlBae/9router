# Artifact Plan — danh sách tệp, chủ quyền, vòng đời

`OWNER` = pha tạo ra. `LIFETIME` = giữ bao lâu. `SECRET` = có chứa credential hay không.

## A. Tài liệu (đã giao — P0)

| Tệp | Purpose | LIFETIME | SECRET |
|---|---|---|---|
| `muse/master-plan.md` | mục lục, pha, cổng, rủi ro, nhật ký quyết định | vĩnh viễn | no |
| `muse/spec.md` | yêu cầu R1–R14 + protocol `[V]/[I]/[H]` + taxonomi lỗi | vĩnh viễn | no |
| `muse/sdd.md` | biên giới module, interface, seam trong bundle | vĩnh viễn | no |
| `muse/tdd.md` | inventory test N/W/S/H/B/P/M/Y/X + gate trước live | vĩnh viễn | no |
| `muse/harness.md` | port, env, lệnh chạy, capture, thủ tục restart | vĩnh viễn | no |
| `muse/check-list.md` | cổng C0–C7, trong đó C5 = cổng restart | vĩnh viễn | no |
| `muse/progress.md` | ledger bằng chứng M1–M5 + câu hỏi mở | cập nhật mỗi pha | no |
| `muse/artifact-plan.md` | chính tệp này | vĩnh viễn | no |

## B. Đã có từ P0 (probe)

| Tệp | Purpose | OWNER | LIFETIME | SECRET |
|---|---|---|---|---|
| `muse/probe-session.mjs` | đo Node có được `/api/session` chấp nhận không (h1 + h2) | P0 | giữ — dùng lại mỗi lần nghi credential | no (tự redact) |
| `muse/probe-wake.mjs` | renew → wake → poll RUNNING → mint token | P0 | giữ | no |
| `muse/probe-gateway.mjs` | soi surface HTTP trên gateway + thử WS upgrade 0 byte | P0 | giữ | no |

## C. Driver (P1–P2)

| Tệp | Purpose | OWNER | SECRET |
|---|---|---|---|
| `muse/lib/noise.cjs` | Noise_XX_25519_AESGCM_SHA256, chỉ `node:crypto` | P1 | no |
| `muse/lib/pb.cjs` | protobuf wire tối thiểu (varint/tag/length-delimited) | P1 | no |
| `muse/lib/wire.cjs` | frame + `splitNoisePayload`/`NoiseReassembler`/`Reset` | P1 | no |
| `muse/lib/gateway.cjs` | `HatchConnection`: stream multiplex, ack, Reset, retry upgrade | P1 | **yes khi chạy** (mang auth_token trong memory) |
| `muse/lib/jar.cjs` | cookie jar + persist atomic + throttle | P2 | yes (memory) |
| `muse/lib/session.cjs` | bootstrap: renew/wake/waitRunning/tokens | P2 | yes (memory) |
| `muse/lib/history.cjs` | poll `/chat/history`, settle 2 s, chống cắt cụt | P2 | no |
| `muse/lib/approvals.cjs` | policy `off\|deny\|allow_*`, scope theo thread | P2 | no |
| `muse/lib/media.cjs` | `/media/raw` → `/fs/raw`, phân biệt video/poster, dedup upload | P4 | no |
| `muse/lib/pool.cjs` | nhiều account, máy trạng thái, cooldown, affinity | P2 | **yes on disk** (đọc từ pool.json) |
| `muse/muse-bridge.cjs` | API ra ngoài: `models/chat/image/video/testConnection/healthz` + `wrap()` | P2–P4 | yes (memory) |

## D. Vỏ chạy (P3, P5)

| Tệp | Purpose | OWNER | SECRET |
|---|---|---|---|
| `muse/sidecar.cjs` | HTTP `:20141`, `/v1/models`, `/v1/chat/completions`, `/v1/images/generations`, `/v1/videos`, `/healthz` | P3 | yes (đọc key từ env) |
| `muse/patch-9r-muse-executor.js` | installer P5: needle count=1, backup, `node --check`, `--dry-run` | P5 | no |
| `%APPDATA%/9router/runtime/muse-web-http-executor.cjs` | bản driver được nạp bởi keeper (seam đã kiểm chứng) | P5 | no (file code) |
| sửa `9r-net-keeper.js` | thêm ~6 dòng set `globalThis.__9rMuseWrap`, mọi bước try/catch | P5 | no |
| sửa `reinstall-9router-fixes.js` | đăng ký patch muse để sống qua `npm i -g 9router` | P5 | no |

## E. Test & harness

| Tệp | Purpose | OWNER | SECRET |
|---|---|---|---|
| `muse/test-noise.js` | N1–N6, gồm vector `Noise_Pattern.txt` | P1 | no |
| `muse/test-wire.js` | W1–W6, golden bytes | P1 | no |
| `muse/fake-gateway.mjs` | server Node cài cùng giao thức, replay fixture, bind 127.0.0.1:20142 | P1 | no (synthetic cookies) |
| `muse/test-session.js` | S1–S7 (wake-403 trap, cookie rotation, 401 vs 403) | P2 | no |
| `muse/test-history.js` | H1–H7 (settle, reply_to, ack-less, approvals, abort) | P2 | no |
| `muse/test-muse-bridge.js` | B1–B8 (OpenAI shape, kind, session isolation, <250 ms) | P2 | no |
| `muse/test-pool.js` | P1–P5 (parallel-not-shared, cooldown, no mid-stream failover) | P2 | no |
| `muse/test-media.js` | M1–M6 (array shape, poster refusal, upload dedup, ceiling) | P4 | no |
| `muse/test-sidecar.js` | Y1–Y5 (auth, models, **no credential in healthz**, loopback bind, port busy) | P3 | no |
| `muse/test-muse-live.js` | một turn live, **bắt buộc `MUSE_LIVE=1`**, in `label` không in cookie | P2 | no |
| `muse/gw-check.js` | gọi Muse **bằng key 9router** qua :20129 (kế thừa `../gw-test.js`) | P3 | no |
| `muse/parallel-muse.js` | 6 turn đồng thời → trả lời câu hỏi "nhiều luồng" bằng số | P3 | no |
| `muse/doctor.js` | port bận? `hatch_vml` còn bao lâu? driver load được? tunnel bật chưa? | P3 | no |
| `muse/cleanup.js` | tắt sidecar, huỷ node đã đăng ký, **không** đụng bundle | P3 | no |

## F. Fixture & dữ liệu runtime

| Tệp | Purpose | OWNER | SECRET | LIFETIME |
|---|---|---|---|---|
| `muse/fixtures/capture-<date>.json` | request/response thật đã **cắt credential** từ `capture-muse.mjs` | P1/P4 | **phải được làm sạch** — check-list C1 kiểm grep | vĩnh viễn |
| `muse/fixtures/golden-*.bin.json` | bytes từng frame để W1/N-chunk | P1 | no | vĩnh viễn |
| `muse/capture-muse.mjs` | điều khiển tab muse.ai đã đăng nhập, dump network + WS frame | P1 | no (redact trước khi ghi) | vĩnh viễn |
| `muse/baseline-muse-web.json` | số đo đường Playwright (TTFB/wall) để mọi pha sau phải thắng | P2 | no | vĩnh viễn |
| `muse/sidecar.log` | log vận hành | P3 | **no — redact bắt buộc** (Y3) | xoay 5 MB |
| `%APPDATA%/9router/muse/pool.json` | account + cookie + trạng thái | P2 | **YES, mode 600** | vĩnh viễn tới khi xoá |

## G. Tái sử dụng, KHÔNG viết lại

| Tệp hiện có | Dùng cho |
|---|---|
| `../gw-test.js` | SSE-frame parsing (9router trả SSE kể cả non-stream) — nền cho `gw-check.js` |
| `../test-lanes.js` | khuôn harness: `node:http` giả + sqlite fixture + `PASS/FAIL`+`ALL PASS` |
| `../9r-net-keeper.js` | DNS stale-if-error; chính là file gánh loader `__9rMuseWrap` ở P5 |
| `../9r-hedge-gateway.js` | hedging/circuit-breaker phía trước Muse; `MODEL_SPECIFIC` quyết định lỗi nào là của model |
| `../reinstall-9router-fixes.js` | nơi đăng ký patch muse để sống qua npm upgrade |
| `../mixed-parallel.js`, `../sim-subagents.js` | khuôn đo song song cho `parallel-muse.js` |
| DB read-only (`better-sqlite3`) | kiểm chứng R9, đọc credential đã lưu, không cần anh dán lại cookie |

## H. Artefact tôi **từ chối** tạo

| Không làm | Lý do |
|---|---|
| `muse/login-muse.mjs` (đăng nhập tự động) | muse.ai login = email + OTP; không có flow nào trong 3 repo; tự động hoá đẻ tài khoản là việc của `tools/mailtm_otp.py` — rõ ràng ngoài đạo đức dùng cá nhân |
| Wrapper chạy `czg86389-hub/muse2api` như dependency | repo CDP-only, có self-updater gọi GitHub không xin phép, `POST /admin/repo/push` đẩy mã của máy anh lên repo người khác |
| Bộ model id kiểu `muse-spark-1.3` cho wire Muse | id đó thuộc catalogue OpenCode/models.dev, **không tồn tại trên wire**; wire không có field model |
| Endpoint quota giả | `protocol.json` 352 route không có route quota; bịa số token còn lại còn hại hơn báo "không rõ" |

---

## Bo sung sau khi do live (2026-11-03, P1-P5) `[V]`

| File | Vai tro | Nhay cam |
|---|---|---|
| `lib/noise.cjs` `lib/pb.cjs` `lib/wire.cjs` `lib/gateway.cjs` `lib/session.cjs` `lib/pool.cjs` `lib/media.cjs` | driver truc tiep | khong chua credential |
| `muse-bridge.cjs` | OpenAI chat/models/media <-> tunnel | — |
| `muse-web-http-executor.cjs` | wrapper in-bundle (P5), fallback Playwright | — |
| `sidecar.cjs` | OpenAI-compatible HTTP tren 127.0.0.1:20141 | **khong** bind 0.0.0.0 |
| `fake-tunnel.cjs`, `test-noise/wire/gateway/bridge/media/executor.js` | 55 case offline | cookie gia |
| `probe-live.mjs` `probe-routes.mjs` `probe-media.mjs` `probe-session/wake/gateway.mjs` | do that, gate `MUSE_LIVE=1` | log da redact |
| `patch-9r-muse-executor.js` | cai/hoi P5: backup, node --check, dem needle | — |
| `fixtures/noise-vectors.json` (+ `vectors.txt`, `cacophony.txt`, `build-vectors.cjs`) | vector Noise cong khai | khong phai credential |
| `%APPDATA%/9router/muse/pool.json`, `.../muse/sidecar.key` | runtime secret, 0600 | **ngoai git**, khong log gia tri |
| `%APPDATA%/9router/runtime/muse/**` + `9r-net-keeper.js` (loader) | ban cai P5 | tai tao bang installer |
