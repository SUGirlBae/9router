# Evidence Ledger — Webchat Provider Layer (2026-11-08)

One-command claims with observed output. Approach A (in-bundle installers).

## Offline tests (quota-free)

| Command | Result |
|---|---|
| `node customizations/webchat/qwen-web/test-offline.cjs` | 15 passed, 0 failed, EXIT=0 |
| `node customizations/webchat/qwen-web/test-integration.cjs` | 7 scenarios PASSED, EXIT=0 (after fixing Windows libuv teardown: replaced process.exit with graceful server.close) |
| `node customizations/webchat/kimi-web/test-offline.cjs` | 17 passed, 0 failed, EXIT=0 |
| `node customizations/webchat/test-executor.cjs` | 8 passed, 0 failed, EXIT=0 (after fixing fallback Parent not setting this.baseUrl) |

## Protocol discovery (read-only, no quota)

| Claim | Evidence |
|---|---|
| kimi web chat endpoint exists | unauth POST `https://www.kimi.com/api/chat/new/completion/stream` → HTTP 401 (route exists, needs auth); `/api/chat` → 422; `/api/v1/chat/completions` → 404 |
| qwen web contract | captured `qwen-ui-requests.jsonl`: POST `https://chat.qwen.ai/api/v2/chat/completions`, body {model,messages,stream}, headers authorization/bx-v/bx-ua/bx-umidtoken |
| executor interface | extracted `class ao extends d.H` from chunks/5330.js: constructor(name,{baseUrl}), testConnection(), execute({model,body,stream,credentials,signal,log}) → {response,url,headers,transformedBody} |

## Bundle wiring

| Command | Result |
|---|---|
| `node customizations/patches/patch-9r-qwen-web.js` (dry) | registry needle unique; descriptor SKIPPED (safe) |
| `node customizations/patches/patch-9r-kimi-web.js` (dry) | registry needle unique; descriptor SKIPPED (safe) |
| `... --apply` (both) | EXIT=0; drivers copied to runtime/webchat/*; keeper loaders appended + node --check ok; registry patched + node --check ok; backups .pre-qwenweb.bak/.pre-kimiweb.bak created |
| restart-9router.ps1 | router HTTP 200 on /v1/models after restart (no crash → registry patch scope-safe) |
| grep keeper markers | QWEN-WEB-LOADER + KIMI-WEB-LOADER present (count 2) |

## Live verification (quota-approved by user)

| Probe | Result | Interpretation |
|---|---|---|
| qwen token import (inline diag) | localStorage token len=281 (JWT) | session alive |
| qwen direct Node fetch | HTTP 200 but JSON `ret:["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::..."]` + captcha punish URL | Alibaba anti-bot blocks non-browser TLS/headers → NOT a code bug; requires browser transport |
| qwen auth.js getBearerToken | initially failed (race at domcontentloaded); fixed with waitForFunction; then client.cjs ignored passed token (bug) → fixed to accept token param | two real bugs found+fixed by tests |
| qwen in-page browser fetch | see probe-live.log (pending) | browser transport bypasses anti-bot (same-origin cookies+TLS) |
| kimi live | BLOCKED: no kimi browser profile exists (profiles: 1, SUGirl, default, qwen) | requires user login to kimi.com in a profile before live probe |

## Known gaps (not yet perfect)

1. /v1/models catalog does not list qwen-web/kimi-web (descriptor insertion deferred to avoid corrupting existing providers). Registry entry + web-login connection make them callable; model id `<provider>/<model>` routes correctly even absent from picker.
2. kimi-web live verification PENDING user login: automation profile was logged-out; headful open-login.cjs window open with real-login detection (login-ready.txt) + graceful close (login-close.txt). Once logged in: close gracefully, create connection, restart, probe.
3. qwen-web live completion VERIFIED COMPLETE (see below).
4. Router-level e2e VERIFIED for qwen-web: connection created via web-login map patch; non-stream returns clean "ROUTER_QWEN_OK"; streaming returns OpenAI chat.completion.chunk + [DONE].

## FINAL verified results (qwen-web)

| Probe | Result |
|---|---|
| router non-stream | HTTP 200, content "ROUTER_QWEN_OK", CLEAN=true (no raw SSE) |
| router streaming | HTTP 200, 1 chat.completion.chunk with "QWEN_OK_DONE" + [DONE] (router appends a 2nd [DONE]; harmless) |
| normalizeSSE vs real fixture | 5/5: extracts phase=answer text, excludes thinking_summary, emits [DONE], no response.created leakage |

## Bugs found & fixed during testing

- Windows libuv assert on process.exit during server.close → graceful teardown.
- executor fallback Parent lacked this.baseUrl → set explicitly in constructor.
- client.cjs ignored explicit token param → now `token || await getToken()`.
- auth.js raced SPA hydration → waitForFunction + waitForTimeout.
- installer descriptor patch would corrupt other providers' authHint → disabled (safe skip).
- registry patch originally referenced out-of-scope d.H → scope-independent factory (no Base arg).