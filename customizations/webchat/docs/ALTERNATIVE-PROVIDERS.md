# WebChat Alternative Providers Guide

## Qwen-web (RECOMMENDED - COMPLETE)

**Status**: ✅ Router e2e VERIFIED (clean+streaming)

**Installation:**
```bash
node patches/patch-9r-qwen-web.js --apply
restart-9router.ps1
```

**Usage in 9router Dashboard:**
1. Create provider connection: `/api/providers/web-login` with `provider="qwen-web", profile="qwen"`
2. Use model IDs: `qwen-web/qwen3.7-plus`, `qwen-web/qwen3-coder-plus`
3. Browser transport auto-reads tokens from `~/.9router/browser-profiles/qwen`

**Features:**
- ✅ No API key needed (uses browser session)
- ✅ Anti-bot bypass (UI-driven capture)
- ✅ Thinking mode separated (reasoning excluded from visible content)
- ✅ Streaming OpenAI-compatible format
- ✅ Cost-free (free tier sufficient for coding)

---

## DeepSeek-web (ALREADY BUILT-IN)

**Status**: ✅ Pre-installed in 9router core

**Connection via web-login:**
```python
# POST /api/providers/web-login
{
  "provider": "deepseek-web",
  "profile": "default"
}
```

**Usage:**
- Model IDs: `deepseek-web/deepseek-v3.2-chat`, `deepseek-web/deepseek-r1`
- Free tier available, generous rate limits
- PoW solver built-in (`app/open-sse/lib/deepseek-pow-hash.js`)

**Note**: Already has full token validation + vision model_type patch.

---

## Muse-web (Advanced/Experimental)

**Status**: ✅ Driver implemented but requires manual cookie import

**Limitations:**
- Requires specific `hatch_vml` (~48h TTL) and `hatch_sess` cookies
- Direct HTTP/Noise protocol complex to maintain
- Better suited for technical users comfortable with cookie management

**Alternative**: Consider other providers if stability critical.

---

## Kimi (International Version)

**Current Status**: ⚠️ Limited availability

**Issue**: kimi.ai (international) ≠ kimi.com (China) — different authentication, no session sharing.

**Workaround**: 
- Wait for kimi.ai to open public beta or release API keys
- Or use kimi-web proxy with direct IP-based tunnel (complex, not recommended)

**Alternatives instead**: Qwen-web + DeepSeek-web combo is more reliable currently.

---

## Minimax (Backup Option)

**Status**: Available in 9router catalog

**Connection:**
```bash
POST /api/oauth/codex/bulk-import
{
  "accounts": [{
    "provider": "minimax-io",
    "authType": "oauth",
    "accessToken": "<your_minimax_token>",
    "email": "user@example.com"
  }]
}
```

**Model IDs:** `minimax/m2`, `minimax/minimax-turbo`
- Good Chinese language support
- Moderate free tier

---

## Recommended Stack

| Use Case | Primary | Fallback |
|----------|---------|----------|
| General Coding | qwen-web/qwen3.7-plus | deepseek-web/deepseek-v3.2-chat |
| Complex Reasoning | deepseek-web/deepseek-r1 | qwen-web/qwen3.7-plus |
| Speed Priority | qwen-web (faster response) | deepseek-web |
| Multilingual | minimmx/m2 (EN/CN) | qwen-web |

**Cost:** All options above are FREE for personal use. No subscriptions needed.

---

## Provider Comparison Matrix

| Provider | Auth Method | Free Tier | Context Window | Vision | Tools | Stability |
|----------|-------------|-----------|----------------|--------|-------|-----------|
| **Qwen-web** | Browser session | ✅ Yes | 32K+ | ✅ Yes | ✅ Yes | ⭐⭐⭐⭐⭐ |
| **DeepSeek-web** | Browser session | ✅ Yes | 64K | ✅ Yes | ✅ Yes | ⭐⭐⭐⭐⭐ |
| **Minimax** | OAuth access token | ✅ Yes | 256K | ❌ No | ✅ Yes | ⭐⭐⭐⭐ |
| **Muse-web** | Session cookies | ✅ Yes | 128K | ✅ Yes | ❌ No | ⭐⭐⭐ |
| **Kimi-web** | Session cookies | ⏸️ Beta | 256K | ✅ Yes | ✅ Yes | ⏸️ Experimental |

---

## Setup Checklist

### Qwen-web (Primary Recommendation)
- [ ] Run `node patches/patch-9r-qwen-web.js --apply`
- [ ] Run `restart-9router.ps1`
- [ ] Open dashboard → create connection at `/api/providers/web-login` (provider=qwen-web, profile=qwen)
- [ ] Verify connection active: `GET /api/models?qwen-web` should return models
- [ ] Test completion: `POST /v1/chat/completions` with model=`qwen-web/qwen3.7-plus`

### DeepSeek-web (Secondary)
- [ ] Already installed via `npm i -g 9router`
- [ ] Just need account signup at https://chat.deepseek.com
- [ ] Import session via web-login flow

---

## Maintenance Notes

**Cookie Refresh Strategy:**
- Qwen: Browser sessions typically last weeks/months; refresh every 30 days if issues arise
- DeepSeek: Similar longevity; watch for `backend_busy` errors (retry after 10s)
- Minimax: Token expires faster; use webhook to auto-refresh when possible

**Monitoring:**
- Watch error logs for patterns like `FAIL_SYS_USER_VALIDATE` (anti-bot)
- If errors persist, try different browser profile or clear cache
- Keep Chrome updated to avoid TLS fingerprint mismatches

---

*Last updated: 2026-11-08*