# WebChat Provider Layer - Installation & Usage Guide

## Overview

This directory contains the **webchat provider implementation** for 9router, enabling browser-session-based access to chat providers (Qwen, DeepSeek, Kimi, etc.) without API keys.

### ✅ What's Complete

| Provider | Status | Router e2e | Streaming | Notes |
|----------|--------|------------|-----------|-------|
| **qwen-web** | ✅ COMPLETE | ✅ Verified | ✅ OpenAI format | Recommended primary provider |
| **kimi-web** | ⏸️ PENDING login | ❌ Blocked | N/A | Requires kimi.ai international account |
| **deepseek-web** | ✅ Built-in core | ✅ Built-in | ✅ Built-in | Already in 9router npm package |

---

## Quick Start (5 minutes)

### Option 1: Qwen-web (Recommended)

```bash
# 1. Apply installer
node patches/patch-9r-qwen-web.js --apply

# 2. Restart 9router
restart-9router.ps1

# 3. Create connection via dashboard API
curl http://localhost:20128/api/providers/web-login \
  -H "Authorization: Bearer YOUR_CLI_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen-web","profile":"qwen"}'

# 4. Test completion
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLI_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-web/qwen3.7-plus","messages":[{"role":"user","content":"Hi"}],"stream":false}'
```

### Option 2: Use existing deepseek-web (Built-in)

No installation needed! Just import session:

```bash
curl http://localhost:20128/api/providers/web-login \
  -H "Authorization: Bearer YOUR_CLI_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek-web","profile":"default"}'
```

Then use model IDs like `deepseek-web/deepseek-r1`.

---

## File Structure

```
webchat/
├── qwen-web/                 # Qwen driver modules
│   ├── auth.js              # Token import from localStorage
│   ├── client.cjs           # HTTP client with anti-bot headers
│   ├── sse.cjs              # SSE parser
│   ├── error.cjs            # Error mapping
│   ├── executor.cjs         # Factory pattern executor
│   ├── browser-client.cjs   # UI-driven capture (anti-bot bypass)
│   ├── test-offline.cjs     # Unit tests (15/15 green)
│   ├── test-integration.cjs # Fake server integration (7/7 green)
│   └── probe-live.cjs       # Live router-level probe
├── kimi-web/                # Kimi driver modules
│   ├── browser-client.cjs   # Contenteditable input capture
│   ├── open-login.cjs       # Headful persistent login helper
│   └── ...                  # Same structure as qwen-web
├── fixtures/               # Real captured data for testing
│   └── qwen-real.sse       # Actual Qwen SSE response for normalizeSSE tests
├── docs/                   # Documentation
│   ├── 2026-11-08-qwen-kimi-providers-design.md  # Design spec
│   ├── EVIDENCE-LEDGER.md                         # Test results + commands
│   └── ALTERNATIVE-PROVIDERS.md                   # Provider comparison matrix
├── patches/                # Installers (in parent directory)
│   ├── patch-9r-qwen-web.js
│   ├── patch-9r-kimi-web.js
│   └── patch-9r-weblogin-map.js
└── README.md               # This file
```

---

## Testing

### Offline Tests (No quota consumed)

```bash
cd customizations/webchat

# Unit tests (SSE parser, error mapper, request builder)
node qwen-web/test-offline.cjs    # 15 passed, 0 failed
node kimi-web/test-offline.cjs    # 17 passed, 0 failed

# Integration vs fake server
node qwen-web/test-integration.cjs # 7 scenarios PASSED

# Executor factory test
node test-executor.cjs             # 8 passed, 0 failed

# NormalizeSSE against REAL captured data
node test-normalize.cjs            # 5 passed, 0 failed
```

### Live Verification (Quota-approved by user)

```bash
# Non-streaming
node qwen-web/probe-router-stream.cjs  # HTTP 200 + clean content

# Streaming mode
cat qwen-web/probe-router-sse.log      # Should show OpenAI chunk format + [DONE]
```

---

## Architecture Highlights

### 1. Browser Transport (Anti-Bot Bypass)

Direct Node.js fetch triggers Alibaba Cloudflare anti-bot (`FAIL_SYS_USER_VALIDATE`). Solution:

- Launch headless persistent Chrome context on logged-in profile
- Execute UI actions: click textarea → fill prompt → press Enter
- Capture response via `waitForResponse` → genuine cookies/TLS inherited
- Parse raw SSE upstream → normalize to OpenAI format

### 2. normalizeSSE (Qwen Format Parser)

Real Qwen SSE uses:
```json
data: {"choices":[{"delta":{"content":"Hello!","phase":"answer","status":"typing"}}]}
data: {"choices":[{"delta":{"content":"","phase":"answer","status":"finished"}}]}
```

Parser extracts only `phase="answer"` content (excludes `thinking_summary` reasoning), emits OpenAI-style chunks + `[DONE]`.

### 3. Registry Injection Pattern

Following Muse-web precedent:
- Registry needle unique per provider (`"chatgpt-web":`, `"gemini-web":`)
- Wrap factory hook: `(globalThis.__9rQwenExec?new (globalThis.__9rQwenExec())():fallback)`
- Keeper loader appends guarded require block with marker (`QWEN-WEB-LOADER`)
- Descriptor insertion deferred to avoid corrupting other providers' authHints

### 4. Idempotent Installers

Each installer:
- Dry-run first (writes nothing, verifies needle uniqueness)
- Backup `.pre-{provider}.bak` before apply
- Syntax gate via `node --check`
- Revert option available anytime

---

## Troubleshooting

### "No active credentials for provider"

Create connection via web-login API:
```bash
POST /api/providers/web-login
{"provider":"qwen-web","profile":"qwen"}
```

### Anti-bot errors (`RGV587_ERROR`)

Use browser transport (already implemented). Direct Node fetch won't work.

### Session expired

Refresh browser profile login:
1. Open `~/.9router/browser-profiles/qwen` in Chrome manually
2. Log in again
3. Restart 9router to reload cookies

### Model not found in `/v1/models`

Expected behavior — registry entry makes provider callable but catalog descriptor insertion deferred to prevent corruption. Use full model ID: `qwen-web/qwen3.7-plus`.

---

## Next Steps

1. **Kimi-web**: Complete login flow with kimi.ai (international version) instead of kimi.com
2. **Alternative providers**: See `docs/ALTERNATIVE-PROVIDERS.md` for Minimax, DeepSeek options
3. **Production hardening**: Add auto-refresh logic, monitoring, fallback lanes

---

## Evidence Ledger

All test results documented in `docs/EVIDENCE-LEDGER.md`:
- Commands executed + exact outputs
- Bug fixes verified (race conditions, scope issues, token guards)
- Final verification: qwen-web router e2e COMPLETE (clean + streaming)

---

*Last updated: 2026-11-08*  
*Commits pushed: 1dcf80c2 → c3f8dfb0*