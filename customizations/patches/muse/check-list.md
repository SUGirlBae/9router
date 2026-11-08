# Check-list — các cổng chặn

Đọc từ trên xuống. **Mỗi cổng là một dòng `- [ ]`; chưa tick thì chưa sang phần sau.**

## C0 — Trước khi viết bất kỳ code nào

- [ ] Anh đã duyệt `master-plan.md` + bộ tài liệu này.
- [ ] `muse/spec.md` phân loại từng dòng protocol `[V]/[I]/[H]`; driver **không gửi** request chỉ có `[I]` mà chưa được xác nhận.
- [ ] Đã ghi rõ scope: chat + image + video, và **Muse không phải** câu trả lời cho "chạy nhiều sub-agent cùng lúc" (xem `master-plan.md` §4).
- [ ] Đã đọc ToS warning và anh chấp nhận rủi ro tài khoản cho mục đích cá nhân tại local.

## C1 — Bảo mật (làm TRƯỚC khi thêm credential vào bất cứ đâu)

- [ ] **Kiểm tra tunnel:** `GET http://127.0.0.1:20128/api/tunnel/status` — settings hiện **có** `tunnelUrl=https://…trycloudflare.com`. Nếu tunnel đang bật, **dừng lại báo anh** trước khi nối Muse vào router.
- [ ] Sidecar chỉ bind `127.0.0.1` (test Y4 assert điều này).
- [ ] `MUSE_SIDECAR_KEY` được set; sidecar từ chối start khi thiếu (không tự sinh rồi in ra log).
- [ ] `pool.json` mode 600, nằm ngoài thư mục làm việc, không bao giờ commit.
- [ ] Fixture đã cắt cookie/token/`vm_id`/`endpoint_url`; `muse/fixtures/*.json` grep `hatch_sess=` phải **0 kết quả**.
- [ ] `grep -rn "hatch_sess\|auth_token" muse/*.js muse/lib/*` chỉ xuất hiện ở chỗ đọc từ pool, không ở `console.log`.
- [ ] Không nhập `czg86389-hub/muse2api` làm dependency: repo đó có self-updater gọi GitHub không xin phép và endpoint `/admin/repo/push` đẩy mã của máy anh lên repo người khác.
- [ ] Không dùng `tools/mailtm_otp.py` (đẻ tài khoản hàng loạt bằng mail một lần).

## C2 — P1: Noise + wire đúng

- [ ] `test-noise.js`: N1–N6 ALL PASS, **có** so với vector `Noise_Pattern.txt` (N2).
- [ ] `test-wire.js`: W1–W6 ALL PASS, **đặc biệt W4** (inbound chunk lớn được accept — chỗ làm turn treo).
- [ ] `POST /api/ping` qua tunnel thật trả record JSON hợp lệ → bằng chứng cả stack Noise+framing đúng.
- [ ] Không có `console.log` cookie/token.

## C3 — P3: dùng được bằng API key 9router, không restart

- [ ] Toàn bộ `tdd.md` §2 ALL PASS **trước** khi chạm account thật.
- [ ] `node muse/parallel-muse.js 1` một turn live: text không rỗng, TTFB ghi vào `progress.md`, nhanh hơn baseline Playwright.
- [ ] Không có process Chromium/Chrome nào sinh ra khi gọi Muse (kiểm tra `tasklist` hoặc qua gateway log).
- [ ] Node `muse` đăng ký thành công trong 9router, model hiện trong `GET /v1/models`.
- [ ] `gw-check.js muse/muse-spark "…"` → OK **với key của 9router** (R1).
- [ ] `requestDetails` có dòng provider muse (R9).
- [ ] Circuit breaker của `9r-hedge-gateway.js` **không** trip oan vì first-byte chậm của Muse (đã đo `HEDGE_FIRST_BYTE_MS` phù hợp, hoặc đặt lane riêng cho `muse/*`).
- [ ] **KHÔNG** sửa file bundle nào trong pha này.

## C4 — P4: media

- [ ] Ảnh: trả **mảng** `[{b64,mime}]` (shape đã đo `[V]`), `n` được tôn trọng.
- [ ] Video: chỉ nhận nguồn video thật, **từ chối poster/cover** (M2).
- [ ] Không trả lại chính ảnh upload (M3), có trần thời gian (M4), không mồ côi job khi client ngắt (M6).
- [ ] Bật `NINEROUTER_MUSE_HTTP=0`, ảnh/video **vẫn** chạy bằng Playwright → R12 không hồi quy.
- [ ] Nếu capture cho thấy media chỉ sinh được trong VM và không có `/media/raw`, **chốt descoping trong `progress.md`** và nói cho anh, thay vì giả vờ có API.

## C5 — P5: in-bundle

- [ ] **STOP — DÒNG NÀY LÀ CỔNG:** *"khi nào cần restart 9router hãy báo lại cho tôi quyết định"*. Đã báo, anh đã đồng ý, chưa thì **dừng ở đây**.
- [ ] `--dry-run` in đúng diff; số lần xuất hiện needle = **1** (đã đo).
- [ ] Backup `.pre-musehttp.bak` tồn tại và khác file hiện tại.
- [ ] `node --check` trên mỗi file bundle đã sửa.
- [ ] `test-*` X1–X4 ALL PASS, trong đó **X3**: thiếu driver → keeper im lặng bỏ qua, **9router vẫn khởi động được** (driver gãy không được chặn router).
- [ ] `reinstall-9router-fixes.js` đã có entry muse, và chạy 2 lần vẫn sạch (idempotent).
- [ ] Sau restart: `mu`/`muse` hoạt động, **và** dashboard image/video cũ vẫn hoạt động.

## C6 — Vệ sinh cuối

- [ ] `muse/progress.md` cập nhật: cái gì đã chứng minh, cái gì còn `[I]`, cái gì từ chối làm và tại sao.
- [ ] `node muse/doctor.js` sạch; `hatch_vml` còn > 12 h.
- [ ] Không còn file rác trong `muse/`; mọi artifact liệt kê trong `artifact-plan.md` đều có chủ đích.
- [ ] Ghi chú cho anh: account Muse **chết sau ~48 h** vì `hatch_vml`, và cách duy nhất để sống lâu dài là nhiều account trong pool hoặc re-import cookie — đó là giới hạn của Muse, không phải của driver.

## C7 — Reviewer (người thứ hai / agent thứ hai đọc chéo)

- [ ] Tìm chỗ "im lặng nuốt lỗi": catch-block không log, fallback trả rỗng, `resolve()` không giá trị.
- [ ] Tìm chỗ vi phạm "không bao giờ trả 200 rỗng" — đây là lớp lỗi đã mất cả buổi với qoder.
- [ ] Tìm credential trong log/fixture/artefact.
- [ ] Kiểm mỗi con số trong `progress.md` có lệnh tái hiện ở `harness.md`.
- [ ] Kiểm claim "đã verify" nào thực ra chỉ là `[I]`.

---

## Bo sung sau khi do live (2026-11-03, P1-P5) `[V]`

- **C1 (quyet cua anh 2026-11-03)**: tunnel cong khai `rr6g38g.abc-tunnel.us` + trycloudflare **van bat**, anh tu kiem soat key 9router. Sidecar bind 127.0.0.1 + key rieng 0600 => Muse khong mo them cua moi.
- **C2 ĐẠT**: `POST /api/ping` -> 200 `{"ok":true}` qua Noise WS that, lan thu nhat, profile `muse`.
- **C3 ĐẠT**: 55 case offline xanh (noise 6, wire 6, gateway 12, bridge 13, media 7, executor 11).
- **C4 ĐẠT**: turn chat that bang key 9router: `mweb/muse-chat` 12,5 s (json) va 12,1 s (SSE 5 frame + `[DONE]`).
- **C5 ĐẠT (P5)**: bundle da patch va khoi dong; `muse-web/muse-chat` tra loi truc tiep 10,2 s **khong can sidecar**, dung dung chinh cookie blob 9router dang ky.
- **C6 media (mot phan)**: duong tai va tai anh **da do live** (16912 B webp, `/media/raw` + `/fs/raw` deu 200, 0 quota nho turn da sinh). Chua chay live `POST /v1/images/generations` sau khi sua path — can mot luot sinh moi neu anh muon.
- **C7 rollback**: `node muse/patch-9r-muse-executor.js --revert` (phuc hoi 5330.js + 2598.js tu `.pre-musehttp.bak`) roi restart; go `mweb` bang `DELETE /api/provider-nodes/<id>` + `DELETE /api/providers/<connectionId>`.
- **Phat hien khac**: Playwright executor cu **hong san** voi cookie nay (`browserContext.addCookies: Invalid cookie fields`, do cookie `__Host-`), nen fallback cua muse-web media khong co gi de roi. Chat thi van chay.

- **C6 ĐẠT (đã đo lại)**: `POST /v1/images/generations` model `muse-web/muse-image` → 200, 36,1 s, 15334 B `RIFF/WEBP` thật, đúng hợp đồng `{b64_json, mime_type}` của 9router. Video vẫn chưa do.
- **C8 còn mở**: autostart cho sidecar (node `mweb` mới cần); `muse-web` in-bundle thì không.

- **C6 ĐẠT đủ**: video live `muse-web/muse-video` → 200, 1m52 s, 725 032 B MP4 hợp lệ (`ftyp`). Ảnh: 200, 36 s, 15 334 B WEBP.
- **C9 ĐẠT**: 6 turn thật song song → 6/6 success, wall 24 s (so ~11 s một turn) — `parallel-router.mjs`.
- **C10 ĐẠT**: sidecar đã nghỉ, node `mweb` đã xoá; Muse chỉ còn một đường trong bundle ⇒ không còn tiến trình anh phải giữ sống.

- **C11 ĐẠT**: `muse-web/muse-chat` đã xuất hiện trong `/v1/models` (vá đủ 4 bản descriptor còn lại: `chunks/4480.js`, `chunks/8499.js`, `static/chunks/1321-*.js`). Dashboard cần hard refresh.
- **C12 ĐẠT**: `tools` được strip thay vì đẩy về browser hỏng; `tool_choice:"required"` → 400 `policy`. 62 case offline xanh.
