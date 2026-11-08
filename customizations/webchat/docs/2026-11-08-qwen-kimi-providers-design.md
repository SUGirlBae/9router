# WebChat Provider Layer Design (đợt 1)

**Mục tiêu:** Thêm hai provider "web-chat" chạy trực tiếp từ trình duyệt đã đăng nhập: `qwen-web` và `kimi-web`. Đây không phải một subsystem mới — mở rộng flow **web-provider** có sẵn trong 9router (pattern đã thành công cho `muse-web` và `deepseek-web`).

## 1. Phạm vi đợt 1 (chốt cứng)

| # | Provider | Lý do | Trạng thái hiện tại |
|---|---|---|---|
| 1 | `qwen-web` | Giải quyết quota/403 của API trả phí; capture UI request đã có | ✅ Contracts được capture: `qwen-ui-requests.jsonl`, `probe-qwen-contract.js` |
| 2 | `kimi-web` | Giải quyết 403 Kimi Code; chat free ở `kimi.com` chưa dùng thử | ⏳ Cần discover protocol; plan: read-only asset fetch → browser capture (quota-gated) |
| ❌ Loại | `kimi-code-api`, `gemini-web-new`, `copilot-web` | Đã có (hoặc khó anti-bot quá so với payoff hiện tại) | — |

**Ràng buộc durability (áp dụng):**
- Refresh cookie chủ động khi gần TTL (không đợi chết âm thầm như `hatch_vml` ≈ 48h).
- DNS keeper warm danh sách host (stale-if-error), không cache lỗi.
- Error upstream (backend_busy, rate_limit) nổi lên caller qua header/text surface.
- Multi-account fallback & lanes (auto/probe/pinned/blocked) theo `x-connection-id`.
- RTK token saver cho tool_result và headroom compression giữ nguyên.

## 2. Kiến trúc tổng thể (Approach A: patch in-bundle)

### 2.1. Flow chuẩn một provider

```
Installer (patch-9r-{provider}.js)
  ├─ Registry 5330: register {kind:"chat", endpoint:path, descriptors:{...}}
  ├─ Descriptors (chunks 2598/4480/8499): expose model list + capabilities (vision/thinking/context_length)
  └─ Executor wrapper: optional Playwright bridge (nếu endpoint yêu cầu DOM session)

Runtime Loader (netkeeper)
  ├─ Preload TLS/cookies per-profile
  └─ Warm DNS entries

Bundle Driver (deployed to STATE/runtime/webchat/{provider})
  ├─ Auth layer: import cookies/localStorage from user profile
  ├─ Session keepalive: refresh token on expiry
  ├─ Protocol layer: build request, parse SSE/response
  └─ Error surfacing: map provider errors to OpenAI-style errors

Web Login Route (route.js)
  └─ Token placeholder filter (DeepSeek pattern): reject logged-out placeholders
```

### 2.2. Deploy tree (fork repo)

```
customizations/
├── patches/
│   ├── reinstall-9router-fixes.js (orchestrator fork copy)
│   ├── patch-9r-qwen-web.js        ← installer
│   ├── patch-9r-kimi-web.js        ← installer
│   └── webchat/
│       ├── qwen-web/
│       │   ├── auth.js             ← localStorage+cookies import
│       │   ├── session.js          ← token refresh logic
│       │   ├── client.cjs          ← HTTP+request builder
│       │   ├── sse.cjs             ← response parser
│       │   └── error.cjs           ← error mapping
│       ├── kimi-web/               ← same structure
│       └── fixtures/               ← fake-server for offline tests
├── runtime/                        ← copy by installers into STATE/runtime
└── docs/                           ← spec/ledger here
```

## 3. Qwen Web Chat Contract (đã extract)

- **Base URL**: `https://chat.qwen.ai`
- **Endpoint** A: `POST /api/v2/chat/completions` (body: `{model,messages,stream}`)
- **Endpoint** B: `POST /api/v2/chat/completions?chat_id=xxx&chat_mode=...` (incremental output=true)
- **Headers anti-bot**: `authorization` (Bearer token), `bx-v`, `bx-umidtoken`, `bx-ua`, `user-agent`, `referer`, `sec-ch-ua*`, `x-request-id`.
- **Model IDs**: `"qwen3.7-plus"` (verified); future IDs can be normalized by regex strip of suffixes `(high)`, `[1m]` (reuse `patch-9r-qd-suffix` mechanism).
- **Response**: SSE text/event-stream, OpenAI-like: `data: {"choices":[{"delta":{"content":"..."}}]}\n\ndata: [DONE]\n`.
- **Errors**: `{"code":..., "message":..., "detail":...}` JSON body hoặc SSE hint events (surface via `hintErr` hook already exists).

**Lưu trữ secret**: Bearer token đọc từ `localStorage` của Chrome profile `qwen` (profile tồn tại: `/c/Users/Administrator/.9router/browser-profiles/qwen`). Không hardcode vào source.

## 4. Kimi Web Chat Contract (CONFIRMED via unauth probe)

**Domain Options:**
- `kimi.com` — Chinese version (requires Chinese phone number for login)
- `kimi.ai` — International version (supports global accounts; recommended for non-Chinese users)

**Endpoint**: `POST /api/chat/{chat_id}/completion/stream` ("new" = fresh conversation).
Unauth probe → HTTP 401 (route exists, needs auth); `/api/chat` → 422; `/api/v1/chat/completions` → 404.

**Auth**: session cookies (NO localStorage "token"; `__cf_bm` is NOT a login signal).

**Transport**: browser UI-driven capture (contenteditable input + Enter + waitForResponse),
same proven pattern as qwen; direct Node fetch not reliable.

**SSE format**: `data: {"event":"cmpl","text":...}` / `{"event":"all_done"}` (parser tolerates OpenAI style).

**Login**: headful persistent profile via `open-login.cjs` (real-login detection: login buttons gone +
chat input present; graceful `ctx.close()` flushes cookies; signal files login-ready.txt / login-close.txt).

**Recommendation**: Use `kimi.ai` for international users who cannot verify Chinese phone numbers.
Update `browser-client.cjs` endpoint from `kimi.com` to `kimi.ai` if needed.

## 5. Installers: idempotent + rollback

Each installer follows Muse pattern exactly:

- Dry-run first (`--dry-run`), no side effects.
- Backup chunks with `.pre-{provider}*.bak`.
- Insert marker needle (`__9r{Provider}Wrap`) in registry chunk 5330.
- Inject descriptor fields in chunks 2598/4480/8499 (capabilities, context_length).
- Copy driver files to `STATE/runtime/webchat/{provider}/`.
- Append `require("PATH_TO_driver")` preload in `cli.js` only if not present (no duplicate preloads).
- Syntax gate (`node --check`) after changes.
- Revert script available (`--revert`).

Orchestrator (`reinstall-9router-fixes.js` fork copy) entry:
```javascript
extra.push(["qwen-web provider", "patch-9r-qwen-web.js"]);
extra.push(["kimi-web provider", "patch-9r-kimi-web.js"]);
```

## 6. Offline Testing (quota-free)

**Fake server** (Node.js + WebSocket/SSE mock):
- Simulate Qwen completions SSE stream with success/failure/error paths.
- Test driver module functions in isolation:
  - `auth.importProfile()` → returns decoded token (redact secrets in logs).
  - `session.refresh()` → new token on expiry.
  - `client.chat({model,messages,stream})` → parses SSE correctly.
  - `error.map(error)` → correct error codes/messages.
- Run all tests; exit non-zero if any fail before pushing code.

**Coverage checklist:**
- Streaming + non-streaming modes.
- Empty stream, stall guard (>10s empty), retry behavior.
- Stale token rejection (HTTP 401 flow).
- Backend busy (HTTP 503/429) surfaced to caller.
- Anti-bot header generation (bx-v, etc.) deterministic.

## 7. Security Gates (before commit)

- No plaintext secrets in pushed tree. Redact `Bearer ...`, `bx-v`, `bx-umidtoken`, `bx-ua` values.
- `.env.example` template for required env vars (`QWEN_BROWSER_PROFILE_PATH`, etc.).
- Rotate any leaked keys in local config before pushing (already done in prior push).

## 8. Milestone Checklist (perfect result criteria)

### Phase 1: Spec + offline work
- [x] Design doc committed to fork repo
- [x] qwen-web driver modules scaffolding completed
- [x] Fake server fixture created (SSE + error paths) + REAL captured fixture qwen-real.sse
- [x] Offline tests green (qwen 15/15, integration 7/7, executor 8/8, normalize 5/5; kimi 17/17)

### Phase 2: Bundle wiring
- [x] Installers patch-9r-qwen-web.js / patch-9r-kimi-web.js written + dry-run verified
- [x] Registry injection verified (node --check, runtime load without crash)
- [x] Drivers deployed to STATE/runtime/webchat/* (browser transport)
- [x] Keeper loaders appended + upgraded to browser transport
- [x] web-login map patch adds qwen-web/kimi-web (connection import)

### Phase 3: Live verification (quota-approved)
- [x] Restart 9router, health poll passes
- [x] qwen-web router e2e non-stream: clean "ROUTER_QWEN_OK"
- [x] qwen-web router e2e streaming: OpenAI chunk + [DONE]
- [x] Error paths offline: stale token 401, backend_busy 503, rate_limit 429, empty stream, hint error
- [ ] kimi-web router e2e: PENDING user login (headful window open, login-ready.txt signal)

### Phase 4: Ledger + push
- [x] Evidence ledger updated with commands + outputs
- [x] Secret redaction verified (no cookies/tokens in pushed tree)
- [x] Commits pushed to master (1dcf80c2, 6cc9d4dc, cf26a161, 14995349)
- [ ] Final kimi verification + push after login

**Completion definition:** All items above green; no missing requirements; evidence ledger complete and verifiable one-command.

## 9. Notes về Durability & Quota

- `hatch_vml` lesson: refresh proactively every ~16h (not wait for 48h TTL expiry).
- Ask quota before live probes; batch them together (single approval).
- If any test fails ≥2 retries → abort, investigate, document failure reason, do NOT force through.

## 10. Next Concrete Step (this turn)

Build qwen-web driver modules + fake-server offine test suite. Write spec diff commits later with code + ledger together.

---

*Spec version: 2026-11-08 v1.0*  
*Drafted by: Qoder + human review*  
*Approved approach: A (patch in-bundle)*