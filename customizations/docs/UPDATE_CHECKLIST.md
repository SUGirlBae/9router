# Update Checklist — Quy trình Nâng cấp An toàn Không Mất Custom

Áp dụng mỗi khi nâng cấp bản gốc `20128` (`9router`) và kiểm tra/port thay đổi mới lên `20130` (`9router-fork`).

---

## A. Cập nhật bản gốc `20128` (`9router`) — KHÔNG ảnh hưởng `20130`

- [ ] **A1. Đảm bảo `20130` (`9router-fork`) đang khỏe** (vì `20128` trỏ qua `20130` và backup `womtech.io.vn`):
  ```powershell
  curl.exe -s http://127.0.0.1:20130/api/health
  ```
- [ ] **A2. Backup DB `20128` trước khi cập nhật** (nếu cần): chỉ rename/copy thành `.bak-*`, không xóa.
- [ ] **A3. Cập nhật bản gốc sạch từ npm**:
  ```powershell
  # Nếu đang chạy 20128, tắt đúng process 20128 (nhờ tray Exit hoặc PID file) trước để tránh EBUSY
  npm i -g 9router@latest --prefer-online
  9router --tray --skip-update
  ```
- [ ] **A4. Xác nhận `9router-fork` (`20130`) không bị chạm**:
  ```powershell
  9router-fork -v
  curl.exe -s http://127.0.0.1:20130/api/health
  curl.exe -s https://rb54hwc.abc-tunnel.us/api/health
  ```

---

## B. Port bản upstream mới từ `20128` sang `20130` (`9router-fork`)

> Lưu ý: Trước khi rebuild/restart `20130`, xác nhận `womtech.io.vn` đang sống trên `20128` để traffic fail-over tự động không bị nghẽn.

- [ ] **B1. Kiểm tra diff upstream mới vs `D:\9router` & `DIFF_REPORT.md`**:
  ```bash
  git -C D:/9router fetch upstream
  git -C D:/9router diff --stat v0.5.119..upstream/master
  ```
- [ ] **B2. Merge vào cây staging sạch (KHÔNG merge đè thẳng `D:\9router` khi chưa test), kiểm tra các điểm nhạy cảm dễ mất**:
  - [ ] `open-sse/config/providerModels.js` → **`aglock`** (giữ `presetSuffix`)
  - [ ] `open-sse/utils/proxyFetch.js` → **`ecdh`** (`X25519:P-256:P-384`)
  - [ ] `open-sse/utils/ingressHeaderSanitizer.js` + `open-sse/handlers/chatCore.js` → lọc dấu vết `20128`/hop
  - [ ] `open-sse/executors/antigravity.js` + `services/antigravityDevice.js` + `providers/{capabilities,shared,registry}` → UA `2.31.1`, `cl=1012564305`, cô lập `accountKey`, model power
  - [ ] `src/mitm/{server.js, telemetrySinkhole.js, manager.js}` → sinkhole `200`, không dùng `setx`
  - [ ] `src/lib/network/netlifyRelay.js` + `proxy-pools/{cloudflare,vercel,netlify,deno}-deploy` + `proxy-pools/{route,[id]/route}` → `STRIP_PREFIXES`, `STRIP_EXACT`, `sso_login: false`, auto-type
  - [ ] `src/app/(dashboard)/dashboard/providers/[id]/{page,ConnectionRow,AddApiKeyModal}.js` + `ConnectionsCard.js` → `providerBoundCount`, `overscroll-contain`, `stopPropagation`
  - [ ] `src/sse/handlers/chat.js` + `src/sse/services/auth.js` → `x-connection-id` pinning + `latencyOrchestrator`
  - [ ] `src/lib/tunnel/{cloudflare,tailscale}/manager.js` → `Number(process.env.PORT) || 20128`
- [ ] **B3. Build CLI standalone & áp lại runtime bundle patches (`customizations/patches/`)**:
  - [ ] `patch-9r-qd-suffix.js`
  - [ ] `patch-9r-qoduck.js`
  - [ ] `patch-9r-qwen-web.js --apply`, `patch-9r-kimi-web.js --apply`, `patch-9r-weblogin-map.js --apply`, `reinstall-muse-executor.js`
  - [ ] Copy `sha3_wasm_bg.wasm` vào `app/open-sse/lib/`
  - [ ] Giữ nguyên vỏ cô lập `9router-fork` (`package.json`, `cli.js`, `src/cli/tray/autostart.js`, `src/cli/api/client.js`)
- [ ] **B4. Chạy bộ kiểm thử bắt buộc TRƯỚC khi thay `9router-fork/app`**:
  ```bash
  node --test D:/9router/tests/unit/fork-launcher-isolation.test.js
  node --test D:/9router/tests/unit/ingress-header-sanitizer.test.js
  node --test D:/9router/tests/unit/bak-parity-restorations.test.js
  npm --prefix D:/9router/tests test -- unit/antigravity-virtual-device.test.js unit/antigravity-proxy-shield.test.js unit/antigravity-protocol-fidelity.test.js unit/capabilities-antigravity-power.test.js unit/registry-antigravity-power.test.js unit/mitm-telemetry-sinkhole.test.js
  ```
- [ ] **B5. Backup `%APPDATA%\9router-fork\db\data.sqlite` thành `.bak`, cập nhật `9router-fork\app`, khởi động lại qua `9router-fork` & kiểm tra**:
  - [ ] `http://127.0.0.1:20130/api/health` → `200`
  - [ ] `https://rb54hwc.abc-tunnel.us/api/health` → `200`
  - [ ] `http://127.0.0.1:20128/api/health` & `https://rr6g38g.abc-tunnel.us/api/health` vẫn `200` không bị ảnh hưởng
  - [ ] Kiểm tra UI `http://localhost:20130/dashboard/providers/antigravity` còn hiện số đếm proxy `providerBoundCount`
- [ ] **B6. Cập nhật `CODE_TREE.md`, `DIFF_REPORT.md` và commit/push lên `origin` (`SUGirlBae/9router`)**.
