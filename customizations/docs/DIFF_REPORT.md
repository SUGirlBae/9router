# Diff Report — Đối chiếu `upstream v0.5.119` (`20128`) vs `9router-fork` (`20130`)

Ngày đối chiếu: 2026-11-13  
Bản gốc trên đĩa (`20128`): `C:\Users\Administrator\AppData\Roaming\npm\node_modules\9router` (`9router@0.5.119` — SHA khớp 100% npm tarball)  
Bản fork custom (`20130`): `C:\Users\Administrator\AppData\Roaming\npm\node_modules\9router-fork` + nguồn tại `D:\9router`

## 1. Thống kê tổng quan
- **Core upstream files modified:** `53` file
- **Core new modules added:** `5` module JS mới (`antigravityDevice.js`, `latencyOrchestrator.js`, `ingressHeaderSanitizer.js`, `telemetrySinkhole.js`, `providers/registry/qwen-web.js`) + asset/docs/scripts
- **Launcher fork isolation (`9router-fork` npm bundle):** `4` file vỏ (`package.json`, `cli.js`, `src/cli/tray/autostart.js`, `src/cli/api/client.js`) — phần `app/` là bản build trực tiếp từ `merged-source-v0.5.119` + `D:\9router`

## 2. Chi tiết 53 file core đã sửa theo nhóm chức năng

### A. Antigravity Anti-Abuse, Protocol Fidelity & Model Power
- `open-sse/config/appConstants.js`: `ANTIGRAVITY_PROMPT_REWRITES` & headers chuẩn IDE.
- `open-sse/config/providerModels.js`: **`pre-aglock`** — giữ nguyên `presetSuffix` trong `getModelUpstreamId()`, không để `tier` ghi đè preset khóa cứng.
- `open-sse/executors/antigravity.js`: UA `antigravity/hub/2.31.1`, bỏ `X-Client-Version`, cô lập `conversationId`/`trajectoryId`/`sessionId` theo `accountKey`, pass-through built-in tools, `modelCeiling` động (128k/65k), `refreshCredentials` truyền `proxyOptions`.
- `open-sse/providers/shared.js`, `open-sse/providers/capabilities.js`, `open-sse/providers/registry/{antigravity,codex,index}.js`: mở khóa full specs Gemini 4/3.8, `gemini-pro-agent(high)`, `gpt-6.1-sol[1m]`/`gpt-6.1-terra[1m]`.
- `open-sse/handlers/imageProviders/antigravity.js`, `open-sse/handlers/search/chatSearch.js`: `gemini-3.8-flash` & image config.
- `open-sse/services/{antigravityDevice.js [NEW], projectId.js, tokenRefresh.js, tokenRefresh/providers.js, usage/antigravity-weekly.js, usage/google.js}`: virtual device profile động, cache projectId, refresh qua proxy, weekly quota.
- `open-sse/translator/{concerns/thinkingUnified.js, formats/maxTokens.js, request/claude-to-openai.js, request/openai-to-claude.js, request/openai-to-gemini.js}`: bỏ cap 64k cứng, truyền thinking & temperature/seed.
- `src/mitm/{antigravityIdeVersion.js, manager.js, server.js, telemetrySinkhole.js [NEW]}`: MITM sinkhole (`x-9router-sinkhole`), bỏ `setx NODE_EXTRA_CA_CERTS` (chỉ dọn bằng `reg delete`).

### B. Egress Filtering, Hop Sanitization & Relay IP-Stripping
- `open-sse/utils/ingressHeaderSanitizer.js` **[NEW]** + `open-sse/handlers/chatCore.js`: xóa sạch `x-forwarded-*`, `x-real-ip`, `forwarded`, `via`, `cf-*`, `cdn-loop`, `x-9r-*`, `x-request-id`, `x-connection-id`, và `User-Agent` của hop `20128` (`undici`/`node`/`9router`) khỏi `credentials.rawHeaders`.
- `open-sse/utils/proxyFetch.js`: **`pre-ecdh`** — `NINEROUTER_TLS_ECDH_CURVE || "X25519:P-256:P-384"`.
- `src/lib/network/netlifyRelay.js`, `src/app/api/proxy-pools/{cloudflare,vercel,netlify,deno}-deploy/route.js`: **`pre-netlifyfix` / `pre-cfdeploy` / `pre-visibility`** — `STRIP_PREFIXES` + `STRIP_EXACT`, `strictProxy: true`, `sso_login: false` & phát hiện Netlify Private `401`.
- `src/app/api/proxy-pools/{route.js, [id]/route.js}`: tự nhận diện `type` (`netlify`/`cloudflare`/`vercel`/`deno`) từ `proxyUrl`.

### C. Orchestration, Pinning & Zero-Downtime Gateway
- `custom-server.js` + `customizations/gateway/9r-zero-downtime-gateway.js`: gateway Blue/Green + xử lý `proxyRes` `aborted`/`error` khi drain.
- `open-sse/services/latencyOrchestrator.js` **[NEW]**, `src/sse/handlers/chat.js` (**`pre-chatpin`** đọc `x-connection-id`), `src/sse/services/auth.js` (**`pre-pinsticky`** + orchestrator + circuit breaker).

### D. Webchat Providers, QoDuck & Dashboard UI
- `open-sse/providers/registry/qwen-web.js` **[NEW]**, `open-sse/executors/{deepseek-web.js, muse-web/session.js}`, `open-sse/services/{webIdentity.js, webLoginConfig.js}`, `src/shared/utils/providerIcon.js`, `src/app/(dashboard)/dashboard/providers/components/WebLoginButton.js`.
- `src/app/(dashboard)/dashboard/providers/[id]/{page.js, ConnectionRow.js, AddApiKeyModal.js}` & `components/ConnectionsCard.js`: **`pre-proxydropdown`** (`providerBoundCount`, badge + tooltip, `overscroll-contain`, `onWheel stopPropagation`), universal *Fetch Models*.
- `src/app/api/models/test/ping.js`, `src/app/api/providers/[id]/models/route.js`, `src/app/api/providers/[id]/test/testUtils.js`: timeout 60s, static models fallback.
- `src/lib/tunnel/{cloudflare,tailscale}/manager.js`: đọc `Number(process.env.PORT) || 20128` thay vì hardcode `20128`.

## 3. Các patch runtime chỉ áp dụng sau bước Next build (`customizations/patches/`)
1. `patch-9r-qd-suffix.js` (`qd/` normalize + suffix strip cho Qoder)
2. `patch-9r-qoduck.js` (`qoduck` → `lmodel` 1M context + reasoning effort)
3. `patch-9r-qwen-web.js`, `patch-9r-kimi-web.js`, `patch-9r-weblogin-map.js`, `reinstall-muse-executor.js` (nối driver webchat qua `%APPDATA%\9router-fork\runtime\9r-net-keeper.js`)
4. `sha3_wasm_bg.wasm` copy vào `app/open-sse/lib/`
5. Cô lập vỏ `9router-fork` (`package.json`, `cli.js`, `src/cli/tray/autostart.js`, `src/cli/api/client.js`) cho cổng `20130` & `DATA_DIR=%APPDATA%\9router-fork`.
