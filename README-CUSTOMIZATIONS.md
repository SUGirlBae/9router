# 9router customizations (SUGirlBae fork)

Complete, reproducible set of local fixes for 9router 0.5.112. All bundle patches
are idempotent installers with backups; `install-customizations.sh` re-applies
everything after an npm update.

## Layout
- `customizations/patches/` — orchestrator `reinstall-9router-fixes.js` + per-fix installers
  (ESM loader, DeepSeek token/vision/hint/PoW, Qoder suffix/chat-pin/pin-sticky/QoDuck 1M,
  DNS netkeeper) and `muse/` direct HTTP/Noise executor driver + installer.
- `customizations/gateway/` — hedge gateway (20129) + resilient proxy.
- `customizations/runtime/` — netkeeper source, status checker, restart script.
- `customizations/probes/` — validation/probe scripts (Qoder entitlement, DeepSeek, Muse).
- `customizations/client-config/` — Qoder/VS Code provider config scripts (API key redacted).
- `customizations/kimi-fixes/` — Kimi diagnostics; see `customizations/docs/fix-kimi-subscription.md`
  (root cause: Kimi Code is a paid tier, not Cloudflare).
- `customizations/docs/` — architecture/protocol/plan notes.

## Install
```bash
./install-customizations.sh          # patches bundle + deploys runtime drivers
pwsh customizations/runtime/restart-9router.ps1
node customizations/runtime/9r-status.js
```

## Security
The plaintext router API key that existed in local config docs was redacted to
`sk-REDACTED-ROTATE-THIS-KEY` in this repo. Cookies, pools, DB, captures and logs
are intentionally NOT included. Rotate the redacted key if it was ever shared.
